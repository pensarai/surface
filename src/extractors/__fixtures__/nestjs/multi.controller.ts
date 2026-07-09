import { Controller, Get } from "@nestjs/common";

// Two controllers in one file: each must get its OWN @Controller prefix.
// A previous bug attributed the first class's decorators to later classes,
// so BetaController's routes were mounted under "alpha".

@Controller("alpha")
export class AlphaController {
  @Get("one")
  one() {
    return { a: 1 };
  }
}

@Controller("beta")
export class BetaController {
  @Get("two")
  two() {
    return { b: 2 };
  }
}
