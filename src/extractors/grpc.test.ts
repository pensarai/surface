import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { grpc } from "./grpc.ts";
import { createScanContext } from "../scan-context.ts";

function extract(fixture: string) {
  const dir = resolve(import.meta.dir, "../../scripts/fixtures", fixture);
  return grpc.extract(createScanContext(dir));
}

describe("grpc proto extraction", () => {
  const eps = extract("grpc-proto");
  const byPath = (p: string) => eps.find((e) => e.path === p);

  test("one endpoint per rpc across all services", () => {
    expect(eps.length).toBe(6);
  });

  test("wire path is /package.Service/Method", () => {
    expect(byPath("/shop.v1.OrderService/CreateOrder")).toBeDefined();
    expect(byPath("/shop.v1.AdminService/Shutdown")).toBeDefined();
  });

  test("detects all four streaming types", () => {
    expect(
      byPath("/shop.v1.OrderService/CreateOrder")!.grpc!.streamingType,
    ).toBe("unary");
    expect(
      byPath("/shop.v1.OrderService/StreamOrders")!.grpc!.streamingType,
    ).toBe("server_stream");
    expect(
      byPath("/shop.v1.OrderService/UploadOrders")!.grpc!.streamingType,
    ).toBe("client_stream");
    expect(byPath("/shop.v1.OrderService/Chat")!.grpc!.streamingType).toBe(
      "bidi",
    );
  });

  test("tags transport and framework as grpc", () => {
    const e = byPath("/shop.v1.OrderService/CreateOrder")!;
    expect(e.transport).toBe("grpc");
    expect(e.framework).toBe("grpc");
    expect(e.grpc!.serviceFqn).toBe("shop.v1.OrderService");
    expect(e.grpc!.method).toBe("CreateOrder");
  });

  test("ignores commented-out rpcs", () => {
    expect(byPath("/shop.v1.OrderService/CommentedOut")).toBeUndefined();
  });

  test("survives braces and slashes inside option-string paths", () => {
    // DeleteOrder is declared AFTER an `option (google.api.http)` block whose
    // path literal contains `{parent=shops/*}` — the exact trap that a
    // non-string-aware comment/brace scanner chokes on.
    expect(byPath("/shop.v1.OrderService/DeleteOrder")).toBeDefined();
  });
});

describe("grpc connect detection", () => {
  const eps = extract("grpc-connect");
  test("maps to the connect transport when a connect toolchain is present", () => {
    expect(eps.length).toBe(1);
    expect(eps[0]!.transport).toBe("connect");
    expect(eps[0]!.framework).toBe("connect");
    expect(eps[0]!.path).toBe("/connectrpc.eliza.v1.ElizaService/Say");
  });
});
