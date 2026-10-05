import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DriftPage } from "@/client/features/drift/DriftPage";
import { driftSearchSchema } from "@/types/schemas/drift";

export const Route = createFileRoute("/_project/p/$projectId/drift")({
  validateSearch: driftSearchSchema,
  component: DriftRoute,
});

function DriftRoute() {
  const { projectId } = Route.useParams();
  const { baselineId, url = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <DriftPage
      projectId={projectId}
      selectedBaselineId={baselineId}
      historyUrl={url}
      onSelectionChange={(nextBaselineId, nextUrl) => {
        void navigate({
          search: {
            baselineId: nextBaselineId,
            url: nextUrl || undefined,
          },
          replace: true,
        });
      }}
    />
  );
}
