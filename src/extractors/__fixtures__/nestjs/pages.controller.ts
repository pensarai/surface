import { Controller, Get, Render } from "@nestjs/common";

@Controller()
export class PagesController {
  @Get("about")
  @Render("about")
  renderAbout() {
    return { title: "About us" };
  }

  // Sibling api method: must NOT inherit the @Render kind from the
  // page handler immediately above it.
  @Get("data")
  getData() {
    return { ok: true };
  }
}
