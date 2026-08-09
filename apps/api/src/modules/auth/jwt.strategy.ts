import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { Model } from 'mongoose';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { User, UserDocument } from './auth.schema';

export interface JwtPayload {
  sub: string; // user _id
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
    const secret = configService.get<string>('JWT_SIGN_SECRET');
    if (!secret || secret.length < 32) {
      throw new Error(
        'JWT_SIGN_SECRET is required (>=32 chars). ' +
        'Generate with: openssl rand -hex 32',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // tokens expire; enforce exp claim
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload): Promise<UserDocument> {
    const user = await this.userModel.findById(payload.sub).select('_id email approved');
    if (!user?.approved) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
