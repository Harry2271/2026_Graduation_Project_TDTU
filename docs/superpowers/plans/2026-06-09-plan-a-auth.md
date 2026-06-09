# Plan A: Auth Layer — JWT API Guards + Web Login

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user registration/approval, JWT-based API protection, and a web login page.

**Architecture:** AuthModule (Mongoose User schema + bcrypt password + Passport JWT guard) on API side; login page + RTK Query interceptor on web side. JWT signed with `JWT_SIGN_SECRET` from `.env`.

**Tech Stack:** NestJS, Passport (jwt strategy), bcrypt, Next.js 16, Redux Toolkit, RTK Query.

**Spec:** `docs/superpowers/specs/2026-06-09-auth-job-brain-wiring-design.md` §2

---

### Task A1: Install API dependencies (bcrypt, @nestjs/passport, passport-jwt)

**Files:**
- Modify: `apps/api/package.json`

- [ ] **Step 1: Add packages**

```bash
cd apps/api && yarn add @nestjs/passport passport passport-jwt bcrypt
yarn add -D @types/passport-jwt @types/bcrypt
```

Key: `bcrypt` (not `bcryptjs`) — native, faster on Pi. `passport-jwt` extracts Bearer token from Authorization header.

- [ ] **Step 2: Commit**

```bash
git add apps/api/package.json apps/api/yarn.lock
git commit -m "feat(api): add passport-jwt and bcrypt dependencies"
```

---

### Task A2: Auth schema + DTOs

**Files:**
- Create: `apps/api/src/modules/auth/auth.schema.ts`
- Create: `apps/api/src/modules/auth/dto/register.dto.ts`
- Create: `apps/api/src/modules/auth/dto/login.dto.ts`

- [ ] **Step 1: Create auth schema**

File: `apps/api/src/modules/auth/auth.schema.ts`

```typescript
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, versionKey: false })
export class User {
  _id!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  @Prop({ required: true })
  password!: string; // bcrypt hash

  @Prop({ default: false })
  approved!: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
```

- [ ] **Step 2: Create register DTO**

File: `apps/api/src/modules/auth/dto/register.dto.ts`

```typescript
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsNotEmpty()
  @MinLength(6)
  password!: string;
}
```

- [ ] **Step 3: Create login DTO**

File: `apps/api/src/modules/auth/dto/login.dto.ts`

```typescript
import { IsEmail, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsNotEmpty()
  password!: string;
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/auth/
git commit -m "feat(api): add User schema and auth DTOs"
```

---

### Task A3: Auth service (register + login logic)

**Files:**
- Create: `apps/api/src/modules/auth/auth.service.ts`

- [ ] **Step 1: Create auth service**

File: `apps/api/src/modules/auth/auth.service.ts`

```typescript
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { User, UserDocument } from './auth.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<{ id: string; email: string; approved: boolean }> {
    const existing = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (existing) {
      throw new ConflictException('Email đã được đăng ký');
    }
    const hash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = await this.userModel.create({
      email: dto.email.toLowerCase(),
      password: hash,
    });
    return { id: user._id, email: user.email, approved: user.approved };
  }

  async login(dto: LoginDto): Promise<{ token: string }> {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    const match = await bcrypt.compare(dto.password, user.password);
    if (!match) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    if (!user.approved) {
      throw new ForbiddenException('Tài khoản chưa được duyệt');
    }
    const token = this.jwtService.sign({ sub: user._id, email: user.email });
    return { token };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/auth/auth.service.ts
git commit -m "feat(api): add auth service with register and login"
```

---

### Task A4: JWT strategy + guard + Public decorator

**Files:**
- Create: `apps/api/src/modules/auth/jwt.strategy.ts`
- Create: `apps/api/src/modules/auth/jwt-auth.guard.ts`

- [ ] **Step 1: Create JWT strategy**

File: `apps/api/src/modules/auth/jwt.strategy.ts`

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './auth.schema';

export interface JwtPayload {
  sub: string;  // user _id
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: true, // permanent tokens per spec
      secretOrKey: configService.get<string>('JWT_SIGN_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<UserDocument> {
    const user = await this.userModel.findById(payload.sub);
    if (!user || !user.approved) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
```

- [ ] **Step 2: Create JWT auth guard + Public decorator**

File: `apps/api/src/modules/auth/jwt-auth.guard.ts`

```typescript
import { Injectable, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/auth/jwt.strategy.ts apps/api/src/modules/auth/jwt-auth.guard.ts
git commit -m "feat(api): add JWT strategy, guard, and Public decorator"
```

---

### Task A5: Auth controller (register + login endpoints)

**Files:**
- Create: `apps/api/src/modules/auth/auth.controller.ts`

- [ ] **Step 1: Create auth controller**

File: `apps/api/src/modules/auth/auth.controller.ts`

```typescript
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './jwt-auth.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiCreatedResponse({ description: 'User registered, awaiting approval' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'JWT token' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/auth/auth.controller.ts
git commit -m "feat(api): add auth endpoints (register + login)"
```

---

### Task A6: Auth module + wire into AppModule

**Files:**
- Create: `apps/api/src/modules/auth/auth.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create auth module**

File: `apps/api/src/modules/auth/auth.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User, UserSchema } from './auth.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SIGN_SECRET'),
        signOptions: { noTimestamp: true }, // permanent token
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 2: Wire into app.module.ts**

Import `AuthModule` and add `JwtAuthGuard` as `APP_GUARD`.

Find the `@Module({ ... })` in `app.module.ts` and add:
```typescript
imports: [
  ...
  AuthModule,
  ...
]
```

Also add the global guard provider:
```typescript
providers: [
  AppService,
  {
    provide: APP_GUARD,
    useClass: JwtAuthGuard,
  },
],
```

Add the import at the top:
```typescript
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
```

Also mark existing public endpoints (healthcheck, AppController) with `@Public()`:

```typescript
// app.controller.ts
import { Public } from './modules/auth/jwt-auth.guard';

@Public()
@Get()
getHello(): string { ... }
```

- [ ] **Step 3: Verify build**

```bash
cd apps/api && yarn build
```

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/app.module.ts apps/api/src/app.controller.ts apps/api/src/modules/auth/auth.module.ts
git commit -m "feat(api): wire auth module with global JWT guard"
```

---

### Task A7: Web login page

**Files:**
- Create: `apps/web/src/app/login/page.tsx`
- Create: `apps/web/src/lib/auth.ts` (JWT helpers)

- [ ] **Step 1: Create auth helper**

File: `apps/web/src/lib/auth.ts`

```typescript
'use client';

const JWT_KEY = 'jwt_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(JWT_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(JWT_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(JWT_KEY);
}
```

- [ ] **Step 2: Create login page**

File: `apps/web/src/app/login/page.tsx`

```typescript
'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';
import { setToken } from '@/lib/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || 'Đăng nhập thất bại');
        return;
      }
      const { token } = await res.json();
      setToken(token);
      router.push('/inventory');
    } catch {
      setError('Không thể kết nối đến server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Đăng nhập</h1>
        {error && <p className={styles.error}>{error}</p>}
        <input
          className={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          className={styles.input}
          type="password"
          placeholder="Mật khẩu"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? 'Đang xử lý...' : 'Đăng nhập'}
        </button>
        <p className={styles.registerLink}>
          Chưa có tài khoản?{' '}
          <a href="/register">Đăng ký</a>
        </p>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Create login page CSS module**

File: `apps/web/src/app/login/page.module.css`

```css
.container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
}

.form {
  background: white;
  padding: 2rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.title {
  text-align: center;
  margin: 0;
  font-size: 1.5rem;
}

.input {
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

.button {
  padding: 0.75rem;
  background: #0070f3;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
}

.button:disabled {
  opacity: 0.6;
}

.error {
  color: #e00;
  text-align: center;
  margin: 0;
  font-size: 0.875rem;
}

.registerLink {
  text-align: center;
  font-size: 0.875rem;
  margin: 0;
}
```

- [ ] **Step 4: Create register page**

File: `apps/web/src/app/register/page.tsx`

```typescript
'use client';

import { useState, FormEvent } from 'react';
import styles from './page.module.css';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage('');
    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMessage(body.message || 'Đăng ký thất bại');
        return;
      }
      setMessage('Đăng ký thành công! Vui lòng chờ quản trị viên duyệt tài khoản.');
      setEmail('');
      setPassword('');
    } catch {
      setMessage('Không thể kết nối đến server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Đăng ký</h1>
        {message && <p className={styles.message}>{message}</p>}
        <input
          className={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          className={styles.input}
          type="password"
          placeholder="Mật khẩu (tối thiểu 6 ký tự)"
          value={password}
          onChange={e => setPassword(e.target.value)}
          minLength={6}
          required
        />
        <button className={styles.button} type="submit" disabled={loading}>
          {loading ? 'Đang xử lý...' : 'Đăng ký'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Create register page CSS module**

File: `apps/web/src/app/register/page.module.css`

Copy the same styles from login's `page.module.css` but replace `.error` with `.message` (green color).

```css
.container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f5f5; }
.form { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 1rem; }
.title { text-align: center; margin: 0; font-size: 1.5rem; }
.input { padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
.button { padding: 0.75rem; background: #0070f3; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
.button:disabled { opacity: 0.6; }
.message { color: #090; text-align: center; margin: 0; font-size: 0.875rem; }
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/login/ apps/web/src/app/register/ apps/web/src/lib/auth.ts
git commit -m "feat(web): add login and register pages with JWT helpers"
```

---

### Task A8: RTK Query interceptor — attach JWT + handle 401

**Files:**
- Modify: `apps/web/src/lib/api.ts` (or find RTK Query base query config)

- [ ] **Step 1: Find RTK Query base configuration**

Read the existing RTK Query setup file to find where `fetchBaseQuery` is configured.

- [ ] **Step 2: Add JWT interceptor**

Add `prepareHeaders` to `fetchBaseQuery`:

```typescript
import { getToken } from './auth';

// In the existing fetchBaseQuery({...})
const baseQuery = fetchBaseQuery({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  prepareHeaders: (headers) => {
    const token = getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  },
});
```

Add a `baseQueryWithAuth` wrapper that catches 401 and redirects:

```typescript
import type { RootState } from '@/store';
import { clearToken } from './auth';
import { useRouter } from 'next/navigation';

const baseQueryWithAuth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, api, extraOptions) => {
  const result = await baseQuery(args, api, extraOptions);
  if (result.error && result.error.status === 401) {
    clearToken();
    window.location.href = '/login';
  }
  return result;
};
```

Update the RTK Query API slice to use `baseQueryWithAuth` instead of `baseQuery`.

- [ ] **Step 3: Verify build**

```bash
cd apps/web && yarn build
```

Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/  # or whatever file was modified
git commit -m "feat(web): add JWT interceptor to RTK Query"
```

---

### Task A9: Add JWT_SIGN_SECRET to deploy.yml and CLAUDE.md

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `apps/api/CLAUDE.md`

- [ ] **Step 1: Add secret reference to deploy.yml**

Find the `deploy-api` job and add the new env var:

```yaml
- name: Deploy API
  ...
  env:
    ...
    JWT_SIGN_SECRET: ${{ secrets.JWT_SIGN_SECRET }}
```

- [ ] **Step 2: Document in CLAUDE.md**

Add to `apps/api/CLAUDE.md` Environment Variables section:

```
| `JWT_SIGN_SECRET` | — | JWT signing secret for auth. Generate with `openssl rand -hex 32`. |
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml apps/api/CLAUDE.md
git commit -m "feat(api): add JWT_SIGN_SECRET to deploy and docs"
```

---

### Task A10: Add JWT_SIGN_SECRET to .env.example and database config

**Files:**
- Create/Modify: `apps/api/.env.example`
- Modify: `apps/api/src/database/database.module.ts` (or ConfigModule validation)

- [ ] **Step 1: Add to .env.example**

File: `apps/api/.env.example`

```bash
JWT_SIGN_SECRET=your-secret-here
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/.env.example
git commit -m "chore(api): add JWT_SIGN_SECRET to .env.example"
```
