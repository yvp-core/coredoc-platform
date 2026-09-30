import { useEffect } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { useAuthStore } from './stores/auth-store';
import { useConfigStore } from './stores/config-store';
import { useProjectsStore } from './stores/projects-store';
import { TooltipProvider } from './components/ui/tooltip';
import { AnalysisPrerequisitesDialog } from './components/AnalysisPrerequisitesDialog';
import { Toaster } from './components/ui/toaster';
import { AppLayout } from './components/AppLayout';
import { TelemetryConsentCard } from './components/TelemetryConsentCard';
import { initTelemetry } from './telemetry';

export function App() {
  const checkAuthStatus = useAuthStore((state) => state.checkAuthStatus);
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const authChangeCount = useAuthStore((state) => state.authChangeCount);
  const loadConfig = useConfigStore((state) => state.loadConfig);
  const loadLocalProjects = useProjectsStore((state) => state.loadLocalProjects);
  const loadCloudProjects = useProjectsStore((state) => state.loadCloudProjects);
  const initialized = useProjectsStore((state) => state.initialized);

  // Load config and local projects on mount (fast, local IPC only)
  useEffect(() => {
    checkAuthStatus();
    loadConfig();
    loadLocalProjects();
    initTelemetry();
  }, [checkAuthStatus, loadConfig, loadLocalProjects]);

  // Load cloud projects once local data is ready and auth is known.
  // authChangeCount ensures we reload when a deep-link callback fires
  // (e.g. accepting an invitation) even if isLoggedIn stays true.
  useEffect(() => {
    if (!initialized) return;
    if (isLoggedIn) {
      loadCloudProjects();
    }
  }, [isLoggedIn, authChangeCount, initialized, loadCloudProjects]);

  return (
    <TooltipProvider>
      <HashRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/project/:projectId" element={<ProjectDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
        <Toaster />
        <AnalysisPrerequisitesDialog />
        <TelemetryConsentCard />
      </HashRouter>
    </TooltipProvider>
  );
}
