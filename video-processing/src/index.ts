import { app, InvocationContext  } from '@azure/functions';
import { trimVideo } from "./trimVideo";

app.storageBlob('trimVideo', {
    path: 'volleyball-videos/inputs/{name}',
    connection: 'AzureWebJobsStorage',
    handler: trimVideo,
});


app.http("getUsers", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (_request, context: InvocationContext) => {
    context.log("HTTP getUsers called");
    return {
      status: 200,
      jsonBody: {}
    };
  }
});
