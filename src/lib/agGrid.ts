// AG Grid v32+ requires explicit module registration. Importing this module
// for its side effect registers every Community feature once at load time.
// Re-exports a wrapped AgGridReact that pins theme="legacy" so the legacy
// CSS file themes (ag-theme-alpine-dark) keep working alongside v33's new
// default Theming API. To migrate to the new API, remove the css imports
// and drop the theme="legacy" default here.

import * as React from "react";
import {
  AgGridReact as BaseAgGridReact,
  type AgGridReactProps,
} from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export function AgGridReact<TData>(
  props: AgGridReactProps<TData>,
): React.ReactElement {
  return React.createElement(BaseAgGridReact, { theme: "legacy", ...props });
}
