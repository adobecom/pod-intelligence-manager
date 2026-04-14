import type { FastifyInstance } from "fastify";
import { addClient } from "../ws/index.js";

export default async function wsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const podId = url.searchParams.get("podId") ?? "global";
    addClient(podId, socket);
  });
}
