import { Controller } from '@nestjs/common';
import { GrpcMethod, GrpcStreamMethod } from '@nestjs/microservices';

@Controller()
export class HeroesController {
  @GrpcMethod('hero.HeroesService', 'FindOne')
  findOne(data: HeroById): Hero { return {} as Hero; }

  @GrpcMethod('hero.HeroesService', 'FindAll')
  findAll(data: Empty): Heroes { return {} as Heroes; }

  @GrpcStreamMethod('hero.HeroesService', 'StreamHeroes')
  streamHeroes(messages: any) { return messages; }
}

@Controller()
export class BillingController {
  @GrpcMethod()
  charge(data: any): any { return {}; }
}
