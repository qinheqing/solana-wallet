import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

/**
 * Stacked on narrow viewports (sidebar on top, scrollable nav), side-by-side
 * from the md breakpoint. `min-w-0` on <main> keeps long monospace strings
 * from forcing the flex child wider than the viewport.
 */
export function Layout() {
  return (
    <div className="flex min-h-screen w-full flex-col bg-zinc-950 text-zinc-100 md:h-screen md:flex-row md:overflow-hidden">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
