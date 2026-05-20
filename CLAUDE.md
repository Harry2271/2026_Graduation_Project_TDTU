# CLAUDE.md - Project Development Guide

This document defines the coding standards, project architecture, and operational commands for this NestJS project.

## 🛠 Operational Commands (Using Yarn)
- **Install Dependencies:** `yarn install`
- **Development Mode:** `yarn start:dev`
- **Build Project:** `yarn build`
- **Linting:** `yarn lint` or `yarn lint --fix`
- **Code Formatting:** `yarn format`
- **Run Tests:** `yarn test` (Unit), `yarn test:e2e` (End-to-end)

## 🏗 System Architecture (Controller -> Service -> Repository)
Strictly follow the layered architecture to ensure Separation of Concerns:

1.  **Controller:** Handles HTTP requests/responses and delegates data to services. Contains zero business logic.
2.  **Service:** Contains core business logic. Interacts with repositories through Interfaces.
3.  **Repository:** Handles data access logic (Mongoose/MongoDB). Encapsulates database implementation details away from services.
4.  **Interface:** All Services and Repositories must be defined via Interfaces to support Dependency Inversion and simplify unit testing.

## 📏 Coding Guidelines (Clean Code & Linting)
- **TypeScript:** Enforce strict typing. The use of `any` is strictly prohibited.
- **Naming Conventions:**
    - Classes: `PascalCase` (e.g., `UserController`).
    - Methods/Variables: `camelCase` (e.g., `getUserById`).
    - Interfaces: Must start with a capital `I` (e.g., `IUserService`).
    - Folders/Files: `kebab-case` (e.g., `user-repository.interface.ts`).
- **Functions:** Keep functions short, focused, and adhering to the Single Responsibility Principle.
- **Dependency Injection:** Always use constructor injection to inject dependencies.

## 💾 Mongoose & MongoDB
- Explicitly define schemas and documents with strong typing.
- **Mongoose schema properties** (fields decorated with `@Prop`) must use the definite assignment assertion (`!`) because Mongoose assigns them at runtime, not in the constructor:
    ```typescript
    @Schema({ timestamps: true })
    export class Package {
      @Prop({ required: true })
      packageName!: string; // ← the ! is required
    }
    ```
- **Do not manually declare `_id`** — it is auto-managed by MongoDB/Mongoose and is already available on the document type.
- Use **Data Transfer Objects (DTOs)** for incoming data validation via `class-validator`.
- Handle database-specific errors within the Repository layer or isolate them using NestJS Exception Filters.
- **Dependency Injection Tokens for Interfaces:** NestJS cannot resolve TypeScript interfaces at runtime (they are erased in JavaScript). For repository interfaces, use a string injection token:
    ```typescript
    // interfaces/package-repository.interface.ts
    export const IPACKAGE_REPOSITORY = 'IPACKAGE_REPOSITORY';
    export interface IPackageRepository { ... }
    ```
    ```typescript
    // package-repository.ts
    export const PackageRepositoryProvider = {
      provide: IPACKAGE_REPOSITORY,
      useClass: PackageRepository,
    };
    ```
    ```typescript
    // package-service.ts
    constructor(
      @Inject(IPACKAGE_REPOSITORY)
      private readonly packageRepository: IPackageRepository,
    ) {}
    ```

## ⚠️ Error Handling
- Utilize NestJS built-in `HttpException` or its subclasses (`NotFoundException`, `BadRequestException`).
- Never expose raw database errors or stack traces to the client.