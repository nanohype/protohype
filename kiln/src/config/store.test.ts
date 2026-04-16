import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConfigStore, AclError } from "./store.js";
import type { CallerContext } from "./acl.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const validConfigItem = {
  teamId: "team-a",
  orgId: "nanocorp",
  watchedRepos: ["nanocorp/api"],
  targetVersionPolicy: "latest",
  reviewSlaTtlHours: 168,
  pinnedSkipList: [],
  groupingStrategy: { type: "per-dep" },
  enabled: true,
};

const ownerCaller: CallerContext = {
  callerTeamId: "team-a",
  isPlatformTeam: false,
  orgId: "nanocorp",
};

const platformCaller: CallerContext = {
  callerTeamId: "platform",
  isPlatformTeam: true,
  orgId: "nanocorp",
};

const otherTeamCaller: CallerContext = {
  callerTeamId: "team-b",
  isPlatformTeam: false,
  orgId: "nanocorp",
};

function makeStore() {
  const client = DynamoDBDocumentClient.from({} as never);
  return new ConfigStore({ tableName: "kiln-config", client });
}

describe("ConfigStore.getConfig", () => {
  it("returns config for the owning team", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validConfigItem });

    const store = makeStore();
    const config = await store.getConfig(ownerCaller, "team-a");
    expect(config.teamId).toBe("team-a");
    expect(config.watchedRepos).toContain("nanocorp/api");
  });

  it("allows platform team to read any team's config", async () => {
    ddbMock.on(GetCommand).resolves({ Item: validConfigItem });

    const store = makeStore();
    const config = await store.getConfig(platformCaller, "team-a");
    expect(config.teamId).toBe("team-a");
  });

  it("throws AclError when a different team tries to read", async () => {
    const store = makeStore();
    await expect(store.getConfig(otherTeamCaller, "team-a")).rejects.toBeInstanceOf(AclError);
  });

  it("throws when config does not exist", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const store = makeStore();
    await expect(store.getConfig(ownerCaller, "team-a")).rejects.toThrow(/not found/);
  });
});

describe("ConfigStore.putConfig", () => {
  it("writes config for the owning team", async () => {
    ddbMock.on(PutCommand).resolves({});

    const store = makeStore();
    await expect(
      store.putConfig(ownerCaller, { ...validConfigItem } as never)
    ).resolves.toBeUndefined();

    expect(ddbMock.calls()).toHaveLength(1);
  });

  it("throws AclError when platform team tries to write another team's config", async () => {
    const store = makeStore();
    const teamBConfig = { ...validConfigItem, teamId: "team-b" };
    await expect(store.putConfig(platformCaller, teamBConfig as never)).rejects.toBeInstanceOf(
      AclError
    );
  });
});

describe("ConfigStore.listOrgConfigs", () => {
  it("allows platform team to list org configs", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [validConfigItem, { ...validConfigItem, teamId: "team-c" }],
    });

    const store = makeStore();
    const configs = await store.listOrgConfigs(platformCaller, "nanocorp");
    expect(configs).toHaveLength(2);
  });

  it("throws AclError for non-platform team trying to list org configs", async () => {
    const store = makeStore();
    await expect(store.listOrgConfigs(ownerCaller, "nanocorp")).rejects.toBeInstanceOf(AclError);
  });
});
