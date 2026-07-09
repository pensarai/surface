import { Controller } from "@nestjs/common";
import { GrpcMethod, GrpcStreamMethod } from "@nestjs/microservices";

@Controller()
export class HeroesController {
  @GrpcMethod("HeroesService", "FindOne")
  findOne(data: HeroById): Hero {
    return {} as Hero;
  }

  @GrpcMethod("HeroesService")
  findAll(data: Empty): Heroes {
    return {} as Heroes;
  }

  @GrpcStreamMethod("HeroesService", "StreamHeroes")
  streamHeroes(messages: any) {
    return messages;
  }
}
