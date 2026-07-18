declare module "react-force-graph-3d" {
  import type { ComponentType, Ref } from "react";

  const ForceGraph3D: ComponentType<Record<string, unknown> & { ref?: Ref<unknown> }>;
  export default ForceGraph3D;
}
