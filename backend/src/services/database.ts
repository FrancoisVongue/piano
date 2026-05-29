import { PrismaClient } from '@prisma/client';
import { obs } from './observability';
import { Config } from '../config';

class Database {
  private prisma: PrismaClient;

  constructor(config: Config) {
    this.prisma = new PrismaClient({
      log: config.database.logLevel
        ? [config.database.logLevel]
        : ['error'],
      datasources: {
        db: {
          url: config.database.url,
        },
      },
    });
  }

  get client() {
    return this.prisma;
  }

  async connect() {
    try {
      await this.prisma.$connect();
      obs.logger.info('Database connected');
    } catch (err) {
      obs.logger.error({ err }, 'Database connection failed');
      throw err;
    }
  }
}

export default Database;