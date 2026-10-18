import { createFileRoute } from "@tanstack/react-router";

type IntegrationMapping = { pedido_id: string; source: string; external_order_id: string };

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function normalizeLogisticsStatus(status: string) {
  switch (status) {
    case "pronto":
      return "waiting_courier";
    case "aceito":
      return "accepted";
    case "em_rota":
      return "on_route_to_pickup";
    case "coletado":
      return "picked_up";
    case "entregue":
      return "delivered";
    case "cancelado":
      return "cancelled";
    default:
      return "pending";
  }
}

function authorized(request: Request) {
  const configured = process.env.ROTA66_INTEGRATION_API_KEY;
  if (!configured) return false;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const header = request.headers.get("x-rota66-integration-key");
  return bearer === configured || header === configured;
}

export const Route = createFileRoute("/api/integration/v1/deliveries/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!authorized(request)) return json({ error: "unauthorized" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const externalOrderId = new URL(request.url).searchParams.get("external_order_id")?.trim();

        let pedidoId = params.id;
        let integration: any = null;

        if (externalOrderId) {
          const { data: mapping, error: mappingError } = await supabaseAdmin
            .from("integracao_entregas" as any)
            .select("pedido_id,source,external_order_id")
            .eq("source", "pixel-palace")
            .eq("external_order_id", externalOrderId)
            .maybeSingle();
          if (mappingError) return json({ error: "integration_lookup_failed" }, 500);
          if (!mapping) return json({ error: "delivery_not_found" }, 404);
          const foundMapping = mapping as IntegrationMapping;
          pedidoId = foundMapping.pedido_id;
          integration = foundMapping;
        } else {
          const { data: mapping } = await supabaseAdmin
            .from("integracao_entregas" as any)
            .select("pedido_id,source,external_order_id")
            .eq("pedido_id", params.id)
            .maybeSingle();
          integration = mapping ?? null;
        }

        const { data: pedido, error } = await supabaseAdmin
          .from("pedidos")
          .select("id,status,entregador_id,taxa_entrega,endereco_coleta,endereco_entrega,created_at,updated_at,coleta_confirmada_em,entrega_confirmada_em")
          .eq("id", pedidoId)
          .maybeSingle();
        if (error) return json({ error: "delivery_lookup_failed" }, 500);
        if (!pedido) return json({ error: "delivery_not_found" }, 404);

        return json({
          ok: true,
          delivery: {
            ...pedido,
            logistics_status: normalizeLogisticsStatus(pedido.status),
          },
          integration: integration ? {
            source: integration.source,
            external_order_id: integration.external_order_id,
          } : null,
        });
      },

      POST: async ({ request, params }) => {
        if (!authorized(request)) return json({ error: "unauthorized" }, 401);
        let body: { action?: string };
        try { body = await request.json(); } catch { body = {}; }
        if (body.action !== "cancel") return json({ error: "unsupported_action" }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: mapping, error: mappingError } = await supabaseAdmin
          .from("integracao_entregas" as any)
          .select("pedido_id")
          .eq("source", "pixel-palace")
          .eq("external_order_id", params.id)
          .maybeSingle();

        if (mappingError) return json({ error: "integration_lookup_failed" }, 500);
        const pedidoId = (mapping as Pick<IntegrationMapping, "pedido_id"> | null)?.pedido_id ?? params.id;

        const { data, error } = await supabaseAdmin
          .from("pedidos")
          .update({ status: "cancelado" })
          .eq("id", pedidoId)
          .in("status", ["pronto", "aceito"])
          .select("id,status")
          .maybeSingle();

        if (error) return json({ error: "delivery_cancel_failed" }, 500);
        if (!data) return json({ error: "delivery_not_cancellable" }, 409);
        return json({ ok: true, delivery: data });
      },
    },
  },
});
