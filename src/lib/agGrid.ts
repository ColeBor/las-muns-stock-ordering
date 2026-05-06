// AG Grid v32+ requires explicit module registration. Importing this module
// for its side effect registers every Community feature once at load time.
// Re-exports a wrapped AgGridReact pinned to themeAlpine + dark color scheme,
// matching the previous ag-theme-alpine-dark CSS look but using the new
// Theming API. Each consumer pulls AgGridReact from "@/lib/agGrid" instead
// of "ag-grid-react" so the theme stays consistent across the app.

import * as React from "react";
import {
  AgGridReact as BaseAgGridReact,
  type AgGridReactProps,
} from "ag-grid-react";
import {
  ModuleRegistry,
  AllCommunityModule,
  themeAlpine,
  colorSchemeDark,
} from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

const lasMunsTheme = themeAlpine.withPart(colorSchemeDark);

export function AgGridReact<TData>(
  props: AgGridReactProps<TData>,
): React.ReactElement {
  return React.createElement(BaseAgGridReact, { theme: lasMunsTheme, ...props });
}
