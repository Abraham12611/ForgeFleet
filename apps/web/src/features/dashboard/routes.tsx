// FF-015 (E12) — dashboard route exports for the apps/web composition.
//
// The shell (`src/App.tsx`, E01-owned) mounts these with:
//   import { dashboardRoutes } from "./features/dashboard/routes";
//   ...
//   <Route path="/projects" element={<CommandCenter />} />
//   <Route path="/projects/:id" element={<ProjectOverview />} />
// or by spreading `dashboardRoutes` inside `<Routes>`. Only additive lines in
// the shell; `/` probe and `/fleet` placeholder stay untouched (E01/E13).
import "./dashboard.css";
import { Route } from "react-router-dom";
import { CommandCenter } from "./CommandCenter";
import { ProjectOverview } from "./ProjectOverview";

export const dashboardRoutes = [
  <Route key="projects" path="/projects" element={<CommandCenter />} />,
  <Route key="project" path="/projects/:id" element={<ProjectOverview />} />,
];

export { CommandCenter, ProjectOverview };
