import { app } from '@azure/functions';
import { trimVideo } from "./trimVideo";

app.setup({
    enableHttpStream: true,
});

app.storageBlob('trimVideo', {
    path: 'volleyball-videos/inputs/{name}',
    connection: 'AzureWebJobsStorage',
    handler: trimVideo,
});
