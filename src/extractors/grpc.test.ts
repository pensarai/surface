import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { grpc } from "./grpc.ts";
import { createScanContext } from "../scan-context.ts";
import { map } from "../mapper.ts";
import { getExtractor } from "./index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = (name: string) => path.join(__dirname, "__fixtures__", name);

function extract(fixture: string) {
  return grpc.extract(createScanContext(fixtureDir(fixture)));
}

describe("grpc proto extraction", () => {
  const eps = extract("grpc-proto");
  const byPath = (p: string) => eps.find((e) => e.path === p);

  it("one endpoint per rpc across all services", () => {
    expect(eps.length).toBe(6);
  });

  it("wire path is /package.Service/Method", () => {
    expect(byPath("/shop.v1.OrderService/CreateOrder")).toBeDefined();
    expect(byPath("/shop.v1.AdminService/Shutdown")).toBeDefined();
  });

  it("detects all four streaming types", () => {
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

  it("tags transport and framework as grpc, kind stays api", () => {
    const e = byPath("/shop.v1.OrderService/CreateOrder")!;
    expect(e.transport).toBe("grpc");
    expect(e.framework).toBe("grpc");
    expect(e.kind).toBe("api");
    expect(e.grpc!.serviceFqn).toBe("shop.v1.OrderService");
    expect(e.grpc!.method).toBe("CreateOrder");
  });

  it("ignores commented-out rpcs", () => {
    expect(byPath("/shop.v1.OrderService/CommentedOut")).toBeUndefined();
  });

  it("survives braces and slashes inside option-string paths", () => {
    // DeleteOrder is declared AFTER an `option (google.api.http)` block whose
    // path literal contains `{parent=shops/*}` — the exact trap that a
    // non-string-aware comment/brace scanner chokes on.
    expect(byPath("/shop.v1.OrderService/DeleteOrder")).toBeDefined();
  });
});

describe("grpc connect detection", () => {
  const eps = extract("grpc-connect");
  it("maps to the connect transport when a connect toolchain is present", () => {
    expect(eps.length).toBe(1);
    expect(eps[0]!.transport).toBe("connect");
    expect(eps[0]!.framework).toBe("connect");
    expect(eps[0]!.path).toBe("/connectrpc.eliza.v1.ElizaService/Say");
  });

  it("`--framework connect` resolves the grpc extractor", () => {
    expect(getExtractor("connect")).toBe(grpc);
    const grpcEps = map(fixtureDir("grpc-connect"), {
      frameworkOverride: "connect",
    }).endpoints.all.filter((e) => e.grpc);
    expect(grpcEps.length).toBe(1);
    expect(grpcEps[0]!.transport).toBe("connect");
  });

  test("scopes connect vs plain gRPC per package in a monorepo", () => {
    const mixed = extract("grpc-mixed");
    const byPath = (p: string) => mixed.find((e) => e.path === p);
    expect(byPath("/eliza.v1.ElizaService/Say")!.transport).toBe("connect");
    expect(byPath("/bank.v1.BankService/GetBalance")!.transport).toBe("grpc");
  });
});
