import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageAuditPage } from "@/client/features/page-audit/PageAuditPage";
import { pageAuditSearchSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/_project/p/$projectId/page-audit")({
  validateSearch: pageAuditSearchSchema,
  component: PageAuditRoute,
});

function PageAuditRoute() {
  const { projectId } = Route.useParams();
  const { url = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <PageAuditPage
      projectId={projectId}
      initialUrl={url}
      onUrlChange={(nextUrl) => {
        void navigate({
          search: { url: nextUrl?.trim() || undefined },
          replace: true,
        });
      }}
    />
  );
}
