// AG Grid v32+ requires explicit module registration. Importing this module
// for its side effect registers every Community feature once at load time.
// Any component that mounts <AgGridReact /> must `import "@/lib/agGrid";`
// at least once in the import graph before the grid renders.

import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);
