import "dotenv/config";
import app from "./app";
import { Scanner } from "./lib/scanner";

const port = process.env.PORT ?? 8080;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  Scanner.getInstance().start();
});
