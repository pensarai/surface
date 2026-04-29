// @ts-nocheck — fixture: extractor scans source text, no need to typecheck.
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";

@WebSocketGateway()
export class EventsGateway {
  @SubscribeMessage("message")
  handleMessage(client: unknown, payload: unknown) {
    return { event: "message", data: payload };
  }
}
