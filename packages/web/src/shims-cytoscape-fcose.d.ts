// Type shim for cytoscape-fcose, which has no @types package.
// fcose is a force-directed layout extension for cytoscape; its public surface
// is just a default-exported register function consumed by `cytoscape.use(fn)`.
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const ext: Ext;
  export default ext;
}
