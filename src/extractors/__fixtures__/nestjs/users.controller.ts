// @ts-nocheck — fixture: extractor scans source text, no need to typecheck.
import { Controller, Get } from "@nestjs/common";

@Controller("users")
export class UsersController {
  @Get()
  findAll() {
    return [{ id: 1, name: "Ada" }];
  }
}
