import type { EndpointInfo, FrameworkId } from "./types.ts";

/**
 * Lazy multi-index over an endpoint array.
 *
 * Indexes are built on first access, then cached. The underlying array
 * is immutable after construction — all queries return views over it.
 *
 * Current indexes: by framework, by file, by method.
 * Designed so `impact` can call byFile() + inLineRange() without
 * re-scanning the full array.
 */
export class EndpointIndex {
  private readonly _endpoints: EndpointInfo[];
  private _byFramework: Map<string, EndpointInfo[]> | null = null;
  private _byFile: Map<string, EndpointInfo[]> | null = null;
  private _byMethod: Map<string, EndpointInfo[]> | null = null;
  private _byService: Map<string, EndpointInfo[]> | null = null;
  private _fwCounts: Map<string, number> | null = null;
  private _svcCounts: Map<string, number> | null = null;

  constructor(endpoints: EndpointInfo[]) {
    this._endpoints = endpoints;
  }

  get all(): EndpointInfo[] {
    return this._endpoints;
  }

  get length(): number {
    return this._endpoints.length;
  }

  // -- Framework index --

  groupByFramework(): Map<string, EndpointInfo[]> {
    if (!this._byFramework) {
      this._byFramework = new Map();
      for (const ep of this._endpoints) {
        const list = this._byFramework.get(ep.framework) ?? [];
        list.push(ep);
        this._byFramework.set(ep.framework, list);
      }
    }
    return this._byFramework;
  }

  byFramework(framework: FrameworkId): EndpointInfo[] {
    return this.groupByFramework().get(framework) ?? [];
  }

  frameworkCounts(): Map<string, number> {
    if (!this._fwCounts) {
      this._fwCounts = new Map();
      for (const [fw, eps] of this.groupByFramework()) {
        this._fwCounts.set(fw, eps.length);
      }
    }
    return this._fwCounts;
  }

  // -- Service index --

  groupByService(): Map<string, EndpointInfo[]> {
    if (!this._byService) {
      this._byService = new Map();
      for (const ep of this._endpoints) {
        const key = ep.service ?? "";
        const list = this._byService.get(key) ?? [];
        list.push(ep);
        this._byService.set(key, list);
      }
    }
    return this._byService;
  }

  byService(service: string): EndpointInfo[] {
    return this.groupByService().get(service) ?? [];
  }

  serviceCounts(): Map<string, number> {
    if (!this._svcCounts) {
      this._svcCounts = new Map();
      for (const [svc, eps] of this.groupByService()) {
        if (svc) this._svcCounts.set(svc, eps.length);
      }
    }
    return this._svcCounts;
  }

  // -- File index (for impact command) --

  private ensureFileIndex(): Map<string, EndpointInfo[]> {
    if (!this._byFile) {
      this._byFile = new Map();
      for (const ep of this._endpoints) {
        const list = this._byFile.get(ep.file) ?? [];
        list.push(ep);
        this._byFile.set(ep.file, list);
      }
    }
    return this._byFile;
  }

  byFile(file: string): EndpointInfo[] {
    return this.ensureFileIndex().get(file) ?? [];
  }

  get files(): string[] {
    return [...this.ensureFileIndex().keys()];
  }

  /** Find endpoints in a file whose definition line falls within a range. */
  inLineRange(
    file: string,
    startLine: number,
    endLine: number,
  ): EndpointInfo[] {
    return this.byFile(file).filter(
      (ep) => ep.line >= startLine && ep.line <= endLine,
    );
  }

  // -- Method index --

  private ensureMethodIndex(): Map<string, EndpointInfo[]> {
    if (!this._byMethod) {
      this._byMethod = new Map();
      for (const ep of this._endpoints) {
        const list = this._byMethod.get(ep.method) ?? [];
        list.push(ep);
        this._byMethod.set(ep.method, list);
      }
    }
    return this._byMethod;
  }

  methodCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [method, eps] of this.ensureMethodIndex()) {
      counts[method] = eps.length;
    }
    return counts;
  }

  // -- Iteration --

  [Symbol.iterator](): Iterator<EndpointInfo> {
    return this._endpoints[Symbol.iterator]();
  }
}
