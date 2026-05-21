import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("@/pages/Chat.vue") },
    { path: "/audit", component: () => import("@/pages/AuditLog.vue") },
    { path: "/jobs", component: () => import("@/pages/Jobs.vue") },
    { path: "/sessions", component: () => import("@/pages/Sessions.vue") },
    { path: "/agents", component: () => import("@/pages/Settings.vue") },
    { path: "/settings", component: () => import("@/pages/Settings.vue") },
    { path: "/swarm", component: () => import("@/pages/SwarmDashboard.vue") },
    { path: "/memory", component: () => import("@/pages/MemoryInspector.vue") },
    { path: "/skills", component: () => import("@/pages/Skills.vue") },
    { path: "/federation", component: () => import("@/pages/Federation.vue") },
    { path: "/users", component: () => import("@/pages/Users.vue") },
    { path: "/plugins", component: () => import("@/pages/Plugins.vue") },
    { path: "/mcp", component: () => import("@/pages/McpServers.vue") },
    { path: "/a2a", component: () => import("@/pages/A2APeers.vue") },
    { path: "/cost", component: () => import("@/pages/Cost.vue") },
    { path: "/definitions", redirect: "/agents" },
    { path: "/config-assistant", redirect: "/agents" },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

export default router;
