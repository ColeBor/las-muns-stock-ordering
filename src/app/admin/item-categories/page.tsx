import dynamic from "next/dynamic";

const AdminItemCategories = dynamic(() => import("@/components/AdminItemCategories"));

export const metadata = {
  title: "Item Categories - Las Muns Stock Ordering",
  description: "Manage item categories for stock ordering system",
};

export default function AdminItemCategoriesPage() {
  return <AdminItemCategories />;
}
