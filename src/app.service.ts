import { Injectable } from '@nestjs/common'

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World! This is a NestJS application for Tran Duc Nguyen. First test with server off.'
  }
}
