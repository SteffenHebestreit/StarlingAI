/**
 * MemGraph graph tools — Stage 9.
 *
 * Agents can build, query, and traverse knowledge graphs stored in MemGraph.
 * Typical use cases:
 *   - Entity relationship mapping during research
 *   - Dependency graphs for code analysis
 *   - Knowledge bases that persist across sessions
 *   - Querying the agent shared-memory graph (MemoryRecord nodes)
 *
 * All tools are Tier 1 (write) or Tier 0 (read-only queries).
 * Graph data is durable — it lives until explicitly deleted or the volume is reset.
 */

import { registerTool, type ToolResult } from "./registry.js";
import { isNeo4jAvailable, runCypher, toPlainRecords } from "../db/neo4j.js";

const NOT_AVAILABLE: ToolResult = {
  success: false,
  output: "",
  error: "MemGraph is not available. Ensure MEMGRAPH_URL is set and the memgraph service is running.",
};

// ── graph_upsert_entity ───────────────────────────────────────────────────────

registerTool({
  name: "graph_upsert_entity",
  description: "Create or update a node in the knowledge graph. Labels classify the entity type (e.g. Person, Company, Concept, Finding). Properties are stored on the node. Nodes are uniquely identified by label + name.",
  parameters: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "Node label / entity type (e.g. 'Person', 'Company', 'Technology', 'Finding', 'Concept'). Use PascalCase.",
      },
      name: {
        type: "string",
        description: "Unique identifier for this entity within its label. Used for MERGE (upsert).",
      },
      properties: {
        type: "object",
        description: "Additional properties to store on the node (string, number, or boolean values).",
      },
      sessionId: {
        type: "string",
        description: "Optional: scope this node to a session. Useful for temporary research graphs.",
      },
    },
    required: ["label", "name"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isNeo4jAvailable()) return NOT_AVAILABLE;

    const label = String(args["label"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const name = String(args["name"] ?? "").trim().slice(0, 500);
    const rawProps = typeof args["properties"] === "object" && args["properties"] ? args["properties"] as Record<string, unknown> : {};
    const sessionId = args["sessionId"] ? String(args["sessionId"]) : undefined;

    // Sanitize property keys to prevent Cypher injection
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      const safeKey = k.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeKey) props[safeKey] = v;
    }

    if (!label || !name) return { success: false, output: "", error: "label and name are required" };

    const setClause = Object.keys(props).length > 0
      ? "SET " + Object.keys(props).map(k => `n.${k} = $props.${k}`).join(", ") + (sessionId ? ", n.sessionId = $sessionId" : "")
      : sessionId ? "SET n.sessionId = $sessionId" : "";

    const cypher = `
      MERGE (n:${label} {name: $name})
      ${setClause}
      SET n.updatedAt = datetime()
      ON CREATE SET n.createdAt = datetime()
      RETURN n.name AS name, labels(n) AS labels`;

    try {
      const result = await runCypher(cypher, { name, props, sessionId }, { write: true });
      const rows = result ? toPlainRecords(result) : [];
      return {
        success: true,
        output: `Entity upserted: (${label}:${name})${Object.keys(props).length > 0 ? ` with ${Object.keys(props).length} properties` : ""}\n${JSON.stringify(rows[0] ?? {})}`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── graph_relate ──────────────────────────────────────────────────────────────

registerTool({
  name: "graph_relate",
  description: "Create or update a directed relationship between two entities in the knowledge graph. Both entities must exist (use graph_upsert_entity first or set createIfMissing=true).",
  parameters: {
    type: "object",
    properties: {
      fromLabel: { type: "string", description: "Label of the source entity" },
      fromName: { type: "string", description: "Name of the source entity" },
      relationship: { type: "string", description: "Relationship type in UPPER_SNAKE_CASE (e.g. WORKS_AT, CITES, DEPENDS_ON, FOUNDED_BY)" },
      toLabel: { type: "string", description: "Label of the target entity" },
      toName: { type: "string", description: "Name of the target entity" },
      properties: { type: "object", description: "Optional properties on the relationship (e.g. since, weight, source)" },
      createIfMissing: {
        type: "boolean",
        description: "If true, create endpoint nodes if they don't exist yet (default: false)",
      },
    },
    required: ["fromLabel", "fromName", "relationship", "toLabel", "toName"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isNeo4jAvailable()) return NOT_AVAILABLE;

    const fromLabel = String(args["fromLabel"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const fromName = String(args["fromName"] ?? "").trim().slice(0, 500);
    const relType = String(args["relationship"] ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const toLabel = String(args["toLabel"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const toName = String(args["toName"] ?? "").trim().slice(0, 500);
    const props = typeof args["properties"] === "object" && args["properties"] ? args["properties"] as Record<string, unknown> : {};
    const createIfMissing = args["createIfMissing"] === true;

    if (!fromLabel || !fromName || !relType || !toLabel || !toName) {
      return { success: false, output: "", error: "fromLabel, fromName, relationship, toLabel, toName are required" };
    }

    const matchOrMerge = createIfMissing ? "MERGE" : "MATCH";
    const cypher = `
      ${matchOrMerge} (a:${fromLabel} {name: $fromName})
      ${matchOrMerge} (b:${toLabel} {name: $toName})
      MERGE (a)-[r:${relType}]->(b)
      SET r += $props, r.updatedAt = datetime()
      ON CREATE SET r.createdAt = datetime()
      RETURN a.name AS from, type(r) AS rel, b.name AS to`;

    try {
      const result = await runCypher(cypher, { fromName, toName, props }, { write: true });
      const rows = result ? toPlainRecords(result) : [];
      return {
        success: true,
        output: rows.length > 0
          ? `Relationship created: (${fromLabel}:${fromName})-[:${relType}]->(${toLabel}:${toName})\n${JSON.stringify(rows[0])}`
          : `No relationship created — one or both entities not found (use createIfMissing: true to auto-create)`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── graph_query ───────────────────────────────────────────────────────────────

registerTool({
  name: "graph_query",
  description: "Run a Cypher read query against the knowledge graph. Returns matching nodes, relationships, or computed values. Use for flexible graph lookups, path finding, and aggregations. Always use LIMIT to cap results.",
  parameters: {
    type: "object",
    properties: {
      cypher: {
        type: "string",
        description: "Cypher query (read-only). Always include LIMIT. Example: 'MATCH (p:Person)-[:WORKS_AT]->(c:Company) RETURN p.name, c.name LIMIT 20'",
      },
      params: {
        type: "object",
        description: "Optional parameter map for the query (use $paramName in cypher)",
      },
    },
    required: ["cypher"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isNeo4jAvailable()) return NOT_AVAILABLE;

    const cypher = String(args["cypher"] ?? "").trim();
    const params = typeof args["params"] === "object" && args["params"] ? args["params"] as Record<string, unknown> : {};

    if (!cypher) return { success: false, output: "", error: "cypher is required" };

    // Safety: defense-in-depth keyword block for write operations.
    // The primary enforcement is the neo4j READ session mode (session.READ),
    // which the driver enforces at the server level. This check is a second
    // layer to catch attempts before they reach the wire and to produce a
    // clearer error message than a neo4j access-mode exception.
    const upper = cypher.toUpperCase();
    for (const kw of ["CREATE", "MERGE", "DELETE", "SET", "REMOVE", "DROP", "FOREACH", "CALL apoc.do", "CALL apoc.schema", "CALL db."]) {
      if (upper.includes(kw)) {
        return { success: false, output: "", error: `graph_query is read-only. Use graph_upsert_entity / graph_relate for writes. Blocked keyword: ${kw}` };
      }
    }

    try {
      const result = await runCypher(cypher, params, { write: false });
      const rows = result ? toPlainRecords(result) : [];
      return {
        success: true,
        output: rows.length === 0
          ? "Query returned 0 results."
          : `${rows.length} result(s):\n${JSON.stringify(rows, null, 2)}`,
      };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── graph_find_paths ──────────────────────────────────────────────────────────

registerTool({
  name: "graph_find_paths",
  description: "Find shortest paths between two entities in the knowledge graph. Useful for discovering how entities are connected through relationships.",
  parameters: {
    type: "object",
    properties: {
      fromLabel: { type: "string" },
      fromName: { type: "string" },
      toLabel: { type: "string" },
      toName: { type: "string" },
      maxDepth: {
        type: "number",
        description: "Maximum path length to search (default: 4, max: 8)",
      },
      relationshipTypes: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of relationship types to traverse. Omit to traverse all.",
      },
    },
    required: ["fromLabel", "fromName", "toLabel", "toName"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isNeo4jAvailable()) return NOT_AVAILABLE;

    const fromLabel = String(args["fromLabel"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const fromName = String(args["fromName"] ?? "").trim();
    const toLabel = String(args["toLabel"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const toName = String(args["toName"] ?? "").trim();
    const maxDepth = Math.min(8, typeof args["maxDepth"] === "number" ? args["maxDepth"] : 4);
    const relTypes = Array.isArray(args["relationshipTypes"]) ? args["relationshipTypes"].map(String) : [];

    const relFilter = relTypes.length > 0 ? `:${relTypes.map(r => r.toUpperCase().replace(/[^A-Z0-9_]/g, "_")).join("|")}` : "";

    const cypher = `
      MATCH (a:${fromLabel} {name: $fromName}), (b:${toLabel} {name: $toName})
      MATCH path = shortestPath((a)-[${relFilter}*1..${maxDepth}]-(b))
      RETURN [node IN nodes(path) | {labels: labels(node), name: node.name}] AS nodes,
             [rel IN relationships(path) | type(rel)] AS relationships
      LIMIT 5`;

    try {
      const result = await runCypher(cypher, { fromName, toName }, { write: false });
      const rows = result ? toPlainRecords(result) : [];
      if (rows.length === 0) {
        return { success: true, output: `No path found between (${fromLabel}:${fromName}) and (${toLabel}:${toName}) within depth ${maxDepth}.` };
      }
      const formatted = rows.map(r => {
        const nodes = (r["nodes"] as Array<{ name: string; labels: string[] }>)
          .map(n => `(${n.labels?.join(":")}:${n.name})`).join(" ");
        const rels = (r["relationships"] as string[]).map(rel => `[:${rel}]`).join(" ");
        return `Path: ${nodes}\nRelationships: ${rels}`;
      }).join("\n\n");
      return { success: true, output: `${rows.length} path(s) found:\n\n${formatted}` };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── graph_delete_node ─────────────────────────────────────────────────────────

registerTool({
  name: "graph_delete_node",
  description: "Delete a node and all its relationships from the knowledge graph.",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string" },
      name: { type: "string" },
    },
    required: ["label", "name"],
  },
  async execute(args): Promise<ToolResult> {
    if (!isNeo4jAvailable()) return NOT_AVAILABLE;

    const label = String(args["label"] ?? "").replace(/[^a-zA-Z0-9_]/g, "");
    const name = String(args["name"] ?? "").trim();
    if (!label || !name) return { success: false, output: "", error: "label and name are required" };

    try {
      const result = await runCypher(
        `MATCH (n:${label} {name: $name}) DETACH DELETE n RETURN count(n) AS deleted`,
        { name },
        { write: true },
      );
      const rows = result ? toPlainRecords(result) : [];
      const deleted = (rows[0]?.["deleted"] as number) ?? 0;
      return { success: true, output: deleted > 0 ? `Deleted (${label}:${name}) and its relationships.` : `Node (${label}:${name}) not found.` };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
});
