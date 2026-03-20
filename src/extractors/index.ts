import type { Extractor, FrameworkId } from "../types.ts";
import { flask } from "./flask.ts";
import { fastapi } from "./fastapi.ts";
import { django } from "./django.ts";
import { express } from "./express.ts";
import { nestjs } from "./nestjs.ts";
import { nextjs } from "./nextjs.ts";
import { gin, echo, fiber, netHttp } from "./go.ts";
import { spring } from "./spring.ts";
import { rails } from "./rails.ts";
import { laravel } from "./laravel.ts";
import { sst } from "./sst.ts";
import { serverActions } from "./server-actions.ts";
import { openapi } from "./openapi.ts";

const ALL_EXTRACTORS: Extractor[] = [
  flask,
  fastapi,
  django,
  express,
  nestjs,
  nextjs,
  gin,
  echo,
  fiber,
  netHttp,
  spring,
  rails,
  laravel,
  sst,
  serverActions,
  openapi,
];

const EXTRACTOR_MAP = new Map<FrameworkId, Extractor>(
  ALL_EXTRACTORS.map((e) => [e.id, e]),
);

export function getExtractor(id: FrameworkId): Extractor | undefined {
  return EXTRACTOR_MAP.get(id);
}

export function getAllExtractors(): Extractor[] {
  return ALL_EXTRACTORS;
}
