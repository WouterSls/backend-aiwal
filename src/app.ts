import express from "express";
import cors from "cors";
import usersRouter from "./app/users/users.router";
import proposalsRouter from "./app/proposals/proposals.router";
import delegationRouter from "./app/delegation/delegation.router";

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

app.use("/api/users", usersRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/delegation", delegationRouter);

export default app;
