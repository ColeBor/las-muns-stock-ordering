import dynamic from "next/dynamic";
import PageShell from "@/components/PageShell";

const AdminItemCategories = dynamic(() => import("@/components/AdminItemCategories"));

export const metadata = {
  title: "Item Categories - Las Muns Stock Ordering",
  description: "Manage item categories for stock ordering system",
};

export default function AdminItemCategoriesPage() {
  return (
    <PageShell>
      <AdminItemCategories />
    </PageShell>
  );
}
