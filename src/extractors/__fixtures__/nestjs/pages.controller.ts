import { Controller, Get, Render } from "@nestjs/common";

@Controller()
export class PagesController {
  @Get("about")
  @Render("about")
  renderAbout() {
    return { title: "About us" };
  }
}
