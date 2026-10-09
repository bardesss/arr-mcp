import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type { IdentityResolver } from "../src/core/identity.ts";
import type { MediaServerAdapter } from "../src/services/types.ts";
import { registerGetPlayback } from "../src/tools/getPlayback.ts";

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<unknown>;

const toolsOf = (register: (s: McpServer) => void) => {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  return (
    server as unknown as {
      _registeredTools: Record<string, { handler: Handler }>;
    }
  )._registeredTools;
};

const server = (id: string, type: "jellyfin" | "plex") => {
  const getPlayback = vi.fn(async () => [
    {
      service: id,
      kind: "active",
      itemId: `${id}-1`,
      title: "T",
      user: "Someone",
    },
  ]);
  return {
    adapter: {
      id,
      type,
      getPlayback,
      getNextUp: async () => [],
      getWatchHistory: async () => [],
      listUsers: async () => [{ id: "u", name: "Someone" }],
      listUserLibrary: async () => [],
    } as unknown as MediaServerAdapter,
    getPlayback,
  };
};

const ident = {
  resolve: async () => ({ id: "u", name: "Someone" }),
  hasDefaultUser: true,
} as unknown as IdentityResolver;

describe("get_playback with two media servers", () => {
  it("reads the primary by default and the secondary when asked", async () => {
    const j = server("jellyfin", "jellyfin");
    const p = server("plex", "plex");
    const tools = toolsOf((s) =>
      registerGetPlayback(s, {
        primary: { adapter: p.adapter, identity: ident },
        secondary: { adapter: j.adapter, identity: ident },
      }),
    );

    await tools.get_playback!.handler(
      { detail: "standard", limit: 50, scope: "active" },
      {},
    );
    expect(p.getPlayback).toHaveBeenCalledTimes(1);
    expect(j.getPlayback).not.toHaveBeenCalled();

    await tools.get_playback!.handler(
      { detail: "standard", limit: 50, scope: "active", service: "jellyfin" },
      {},
    );
    expect(j.getPlayback).toHaveBeenCalledTimes(1);
  });

  it("offers service", () => {
    const tools = toolsOf((s) =>
      registerGetPlayback(s, {
        primary: { adapter: server("plex", "plex").adapter, identity: ident },
        secondary: {
          adapter: server("jellyfin", "jellyfin").adapter,
          identity: ident,
        },
      }),
    );
    expect(
      Object.keys(
        (tools.get_playback as unknown as { inputSchema: { shape: object } })
          .inputSchema.shape,
      ),
    ).toContain("service");
  });

  it("refuses a server that is not configured", async () => {
    const tools = toolsOf((s) =>
      registerGetPlayback(s, {
        primary: { adapter: server("plex", "plex").adapter, identity: ident },
      }),
    );
    await expect(
      tools.get_playback!.handler(
        { detail: "standard", limit: 50, scope: "active", service: "jellyfin" },
        {},
      ),
    ).rejects.toThrow(/not configured/);
  });
});

describe("get_playback on one media server", () => {
  it("has no service argument", () => {
    const tools = toolsOf((s) =>
      registerGetPlayback(s, {
        primary: {
          adapter: server("jellyfin", "jellyfin").adapter,
          identity: ident,
        },
      }),
    );
    expect(
      Object.keys(
        (tools.get_playback as unknown as { inputSchema: { shape: object } })
          .inputSchema.shape,
      ),
    ).not.toContain("service");
  });
});
