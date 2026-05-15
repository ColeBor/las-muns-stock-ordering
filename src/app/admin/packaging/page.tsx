import { redirect } from "next/navigation";

// Packaging Types is now a sub-view of /admin/items. This redirect keeps
// any old bookmarks / hardcoded links working.
export default function AdminPackagingTypesPage() {
  redirect("/admin/items");
}
