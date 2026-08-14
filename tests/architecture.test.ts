import { describe, expect, test } from "bun:test";
import { COMMAND_DEFINITIONS, commandDefinition, publicCommandFor } from "../src/contracts/commands";
import { EVAL_DIMENSIONS } from "../src/contracts/evaluation";
import { modalReducer, initialModalState } from "../src/frontend/app/modal-state";
import { parseSseLines } from "../src/frontend/shared/sse-parser";
import { dispatchHttpRoute, EMPTY_ROUTE_DEPENDENCIES, MODULAR_ROUTE_PATHS } from "../src/transport/http/routes";
import type { RouteContext } from "../src/transport/http/routes";

describe("module contracts", () => {
  test("public command definitions are unique and resolve legacy routes", () => {
    expect(new Set(COMMAND_DEFINITIONS.map((definition) => definition.type)).size).toBe(COMMAND_DEFINITIONS.length);
    expect(commandDefinition("CMD-N02")?.execution).toBe("stream");
    expect(publicCommandFor("/api/novel/gacha", { action: "apply" })?.type).toBe("CMD-W18");
    expect(publicCommandFor("/api/novel/chapter/delete", { action: "preview" })).toBeNull();
  });

  test("every public command path has exactly one modular route owner", () => {
    const routePaths = new Set(MODULAR_ROUTE_PATHS);
    expect(routePaths.size).toBe(MODULAR_ROUTE_PATHS.length);
    for (const definition of COMMAND_DEFINITIONS) {
      expect(routePaths.has(definition.path)).toBe(true);
    }
  });

  test("modular dispatcher delegates owned paths once and ignores unknown paths", async () => {
    const calls: string[] = [];
    const legacy = async (pathname: string) => {
      calls.push(pathname);
      return Response.json({ pathname });
    };
    const context = (pathname: string) => ({
      request: new Request(`http://localhost${pathname}`),
      pathname,
      body: {},
      user: { id: "test-user", username: "test-user" },
      requestContext: { userId: "test-user", username: "test-user" },
    }) as RouteContext;

    const response = await dispatchHttpRoute(context("/api/novel/step"), EMPTY_ROUTE_DEPENDENCIES, legacy);
    expect(response?.status).toBe(200);
    expect(calls).toEqual(["/api/novel/step"]);

    calls.length = 0;
    expect(await dispatchHttpRoute(context("/api/not-registered"), EMPTY_ROUTE_DEPENDENCIES, legacy)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("contracts expose stable evaluation dimensions", () => {
    expect(EVAL_DIMENSIONS).toHaveLength(8);
  });

  test("SSE parser handles chunk boundaries", () => {
    const first = parseSseLines("", "data: {\"phase\":\"writing\"}\n\ndata: {\"phase\":");
    expect(first.events).toEqual([{ phase: "writing" }]);
    const second = parseSseLines(first.buffer, "\"result\"}\n\n");
    expect(second.events).toEqual([{ phase: "result" }]);
  });

  test("modal reducer keeps one active modal", () => {
    const open = modalReducer(initialModalState, { type: "open", modal: "settings", settingsTab: "角色" });
    expect(open).toEqual({ open: "settings", settingsTab: "角色" });
    expect(modalReducer(open, { type: "open", modal: "brain" })).toEqual({ open: "brain" });
    expect(modalReducer(open, { type: "close" })).toEqual(initialModalState);
  });

  test("relationship modal state preserves the requested initial tab", () => {
    expect(modalReducer(initialModalState, {
      type: "open-relationship", editable: false, charId: null, tab: "关系图",
    })).toEqual({
      open: "relationship",
      relationship: { editable: false, charId: null, tab: "关系图" },
    });
    expect(modalReducer(initialModalState, {
      type: "open-relationship", editable: true, charId: null,
    })).toEqual({
      open: "relationship",
      relationship: { editable: true, charId: null },
    });
  });
});
