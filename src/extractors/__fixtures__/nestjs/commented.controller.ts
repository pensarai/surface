import { Controller, Get } from "@nestjs/common";

@Controller("real")
export class RealController {
  // class Helper — a comment mentioning the word class must NOT split this
  // controller and reassign the handler below to a phantom class.
  @Get("ping")
  ping() {
    return { ok: true };
  }
}
