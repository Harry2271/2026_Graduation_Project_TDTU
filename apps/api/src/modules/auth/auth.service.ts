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
