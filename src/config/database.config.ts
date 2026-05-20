import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

export const DatabaseConfig = MongooseModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const mongoUri = configService.get<string>('MONGO_URI');

    if (!mongoUri) {
      throw new Error('MONGO_URI is not defined in the environment variables');
    }

    return { uri: mongoUri };
  },
});
