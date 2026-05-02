// Vitest globalSetup — spins DynamoDB Local via testcontainers and creates
// all kiln tables. Integration tests read the endpoint via
// AWS_ENDPOINT_URL_DYNAMODB; the real adapters honor it.
//
// If Docker isn't available, integration tests self-skip via a guard in
// shared.ts so CI without Docker can still run unit tests.

import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

let container: StartedTestContainer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  // Allow callers to point at an already-running DynamoDB Local (CI shortcut).
  if (process.env["AWS_ENDPOINT_URL_DYNAMODB"]) {
    await createTables(process.env["AWS_ENDPOINT_URL_DYNAMODB"]);
    return async () => undefined;
  }

  try {
    container = await new GenericContainer("amazon/dynamodb-local:latest")
      .withExposedPorts(8000)
      .withCommand(["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"])
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
    process.env["AWS_ENDPOINT_URL_DYNAMODB"] = endpoint;
    process.env["AWS_REGION"] = "us-west-2";
    process.env["AWS_ACCESS_KEY_ID"] = "fake";
    process.env["AWS_SECRET_ACCESS_KEY"] = "fake";
    await createTables(endpoint);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[integration setup] could not start DynamoDB Local; integration tests will skip.",
      e instanceof Error ? e.message : e,
    );
    process.env["KILN_INTEGRATION_SKIP"] = "1";
  }

  return async () => {
    if (container) await container.stop({ timeout: 5_000 });
  };
}

async function createTables(endpoint: string): Promise<void> {
  const ddb = new DynamoDBClient({ endpoint, region: "us-west-2" });
  const wait = async (table: string): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      try {
        await ddb.send(new DescribeTableCommand({ TableName: table }));
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };

  const creates: Array<Promise<unknown>> = [];
  creates.push(
    ddb.send(
      new CreateTableCommand({
        TableName: "kiln-team-config",
        AttributeDefinitions: [{ AttributeName: "teamId", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "teamId", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    ).catch(swallowExists),
  );
  creates.push(
    ddb.send(
      new CreateTableCommand({
        TableName: "kiln-pr-ledger",
        AttributeDefinitions: [
          { AttributeName: "teamId", AttributeType: "S" },
          { AttributeName: "idempotencyKey", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "teamId", KeyType: "HASH" },
          { AttributeName: "idempotencyKey", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    ).catch(swallowExists),
  );
  creates.push(
    ddb.send(
      new CreateTableCommand({
        TableName: "kiln-audit-log",
        AttributeDefinitions: [
          { AttributeName: "teamId", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "teamId", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    ).catch(swallowExists),
  );
  creates.push(
    ddb.send(
      new CreateTableCommand({
        TableName: "kiln-rate-limiter",
        AttributeDefinitions: [{ AttributeName: "bucketKey", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "bucketKey", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    ).catch(swallowExists),
  );
  await Promise.all(creates);
  await Promise.all([
    wait("kiln-team-config"),
    wait("kiln-pr-ledger"),
    wait("kiln-audit-log"),
    wait("kiln-rate-limiter"),
  ]);
}

function swallowExists(e: unknown): void {
  if (typeof e === "object" && e !== null && "name" in e && (e as { name: string }).name === "ResourceInUseException") {
    return;
  }
  throw e;
}
