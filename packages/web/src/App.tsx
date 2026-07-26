/**
 * Routing and integration. Screens do not wire themselves in — each exports a
 * component with a pinned interface, and this file is the single place that
 * decides what renders where.
 *
 * Three routes, deliberately chosen never to collide with the API's paths:
 * `/`, `/submit`, `/task/:id` — singular `task`, distinct from the API's plural
 * `/tasks` (docs/api-contract.md §9). In production the api serves this SPA for
 * every GET outside `/tasks*`, `/events` and `/health`, so a collision would
 * make an endpoint unreachable rather than merely ambiguous.
 *
 * The URL is keyed by the immutable task id at every pane count. Handles
 * recycle: `scrape-1` can name a different task an hour later, so a link built
 * from a handle would silently come to mean something else.
 */
import { useState, type ReactElement } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

import { AppShell } from "./screens/AppShell.js";
import { Gate } from "./screens/Gate.js";
import { NotificationsLayer } from "./screens/NotificationsLayer.js";
import { Register } from "./screens/Register.js";
import { Submit } from "./screens/Submit.js";
import { TaskDetail } from "./screens/TaskDetail.js";
import { useAuth, useUnreadCount } from "./store/react.js";

type ShellMode = "register" | "submit" | "detail";

export function App(): ReactElement {
  const { status } = useAuth();

  // The gate replaces the whole app surface rather than sitting on a route:
  // any 401 anywhere discards the stored key and lands here, and that must not
  // depend on where the user happened to be (frontend-brief §4.1).
  if (status !== "authenticated") return <Gate />;

  return (
    <Routes>
      <Route path="/" element={<Shell mode="register" />} />
      <Route path="/submit" element={<Shell mode="submit" />} />
      <Route path="/task/:id" element={<Shell mode="detail" />} />
      {/* The api's SPA fallback serves index.html for any unmatched GET, so an
          unknown client path is a typo, not a server error. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Shell({ mode }: { mode: ShellMode }): ReactElement {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const unreadCount = useUnreadCount();
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const selectedId = mode === "detail" ? (params.id ?? null) : null;
  const openTask = (taskId: string): void => {
    navigate(`/task/${taskId}`);
  };

  return (
    <AppShell
      main={
        mode === "submit" ? (
          <Submit onViewTask={openTask} />
        ) : (
          <Register selectedId={selectedId} />
        )
      }
      // At three panes the detail pane is always present, showing the resting
      // state when nothing is selected; AppShell owns that rendering.
      detail={
        selectedId === null ? null : (
          <TaskDetail id={selectedId} onBack={() => navigate("/")} />
        )
      }
      detailActive={mode === "detail"}
      submitActive={mode === "submit"}
      unreadCount={unreadCount}
      onOpenNotifications={() => setNotificationsOpen(true)}
      overlay={
        <NotificationsLayer
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
          onOpenTask={openTask}
        />
      }
    />
  );
}
