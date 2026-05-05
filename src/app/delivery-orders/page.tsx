import DeliveryOrders from "@/components/DeliveryOrders";

export default function DeliveryOrdersPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16 sm:px-10">
        <DeliveryOrders />
      </div>
    </main>
  );
}
