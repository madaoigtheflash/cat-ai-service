package com.closeai.catai;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 4102;
    private static final String APP_PAGE = "file:///android_asset/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraOutputUri;
    private File cameraOutputFile;
    private PetDatabase petDatabase;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();

    private static class KnowledgeHit {
        final String id;
        final String source;
        final String title;
        final String content;
        final double score;

        KnowledgeHit(String id, String source, String title, String content, double score) {
            this.id = id;
            this.source = source;
            this.title = title;
            this.content = content;
            this.score = score;
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        petDatabase = new PetDatabase(getApplicationContext());

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setBuiltInZoomControls(false);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.setWebViewClient(new LocalOnlyWebViewClient());
        webView.setWebChromeClient(new ImageChooserChromeClient());

        if (savedInstanceState == null) {
            webView.loadUrl(APP_PAGE);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        networkExecutor.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.destroy();
        }
        if (petDatabase != null) {
            petDatabase.close();
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        Uri[] results = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                ClipData clipData = data.getClipData();
                results = new Uri[clipData.getItemCount()];
                for (int i = 0; i < clipData.getItemCount(); i++) {
                    results[i] = clipData.getItemAt(i).getUri();
                }
            } else if (data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            } else if (cameraOutputUri != null && cameraOutputFile != null
                    && cameraOutputFile.exists() && cameraOutputFile.length() > 0) {
                results = new Uri[]{cameraOutputUri};
            }
        }

        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
        cameraOutputUri = null;
        cameraOutputFile = null;
    }

    private class LocalOnlyWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url));
        }

        private boolean handleNavigation(Uri uri) {
            String url = uri.toString();
            if (url.startsWith("file:///android_asset/")) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // 没有可处理该链接的应用时，保持当前页面不变。
            }
            return true;
        }
    }

    private class ImageChooserChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams fileChooserParams
        ) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;

            Intent pickerIntent = new Intent(Intent.ACTION_GET_CONTENT);
            pickerIntent.addCategory(Intent.CATEGORY_OPENABLE);
            pickerIntent.setType("image/*");

            List<Intent> initialIntents = new ArrayList<>();
            Intent cameraIntent = createCameraIntent();
            if (cameraIntent != null) {
                initialIntents.add(cameraIntent);
            }

            Intent chooser = new Intent(Intent.ACTION_CHOOSER);
            chooser.putExtra(Intent.EXTRA_INTENT, pickerIntent);
            chooser.putExtra(Intent.EXTRA_TITLE, "选择猫咪照片");
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, initialIntents.toArray(new Intent[0]));

            try {
                if (fileChooserParams.isCaptureEnabled() && cameraIntent != null) {
                    startActivityForResult(cameraIntent, FILE_CHOOSER_REQUEST);
                    return true;
                }
                startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                return true;
            } catch (Exception error) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
                return false;
            }
        }

        private Intent createCameraIntent() {
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getPackageManager()) == null) {
                return null;
            }

            try {
                File cameraDir = new File(getCacheDir(), "camera");
                if (!cameraDir.exists() && !cameraDir.mkdirs()) {
                    return null;
                }
                cameraOutputFile = File.createTempFile("cat_ai_", ".jpg", cameraDir);
                cameraOutputUri = FileProvider.getUriForFile(
                        MainActivity.this,
                        BuildConfig.APPLICATION_ID + ".fileprovider",
                        cameraOutputFile
                );
                intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraOutputUri);
                intent.setClipData(ClipData.newRawUri("Cat-AI photo", cameraOutputUri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                return intent;
            } catch (IOException error) {
                cameraOutputFile = null;
                cameraOutputUri = null;
                return null;
            }
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public String getConfig() {
            JSONObject config = new JSONObject();
            try {
                config.put("provider", BuildConfig.CAT_AI_PROVIDER);
                config.put("model", BuildConfig.CAT_AI_MODEL);
                config.put("hasKey", !BuildConfig.CAT_AI_KEY_BLOB.isEmpty());
                config.put("standalone", true);
            } catch (JSONException ignored) {
                // 上述值均为简单标量，不会触发正常的 JSON 异常。
            }
            return config.toString();
        }

        @JavascriptInterface
        public String listPets() {
            try {
                return petDatabase.listPets().toString();
            } catch (Exception error) {
                return bridgeError("读取本地档案失败", error).toString();
            }
        }

        @JavascriptInterface
        public String getPet(String petId) {
            try {
                JSONObject pet = petDatabase.getPet(petId);
                return pet == null ? "null" : pet.toString();
            } catch (Exception error) {
                return bridgeError("读取猫咪档案失败", error).toString();
            }
        }

        @JavascriptInterface
        public String replacePets(String petsJson) {
            try {
                int count = petDatabase.replacePets(new JSONArray(petsJson));
                return new JSONObject().put("success", true).put("count", count).toString();
            } catch (Exception error) {
                return bridgeError("保存本地档案失败", error).toString();
            }
        }

        @JavascriptInterface
        public String migrateLegacyPets(String petsJson) {
            try {
                return petDatabase.migrateLegacyPets(petsJson).toString();
            } catch (Exception error) {
                return bridgeError("迁移旧版档案失败", error).toString();
            }
        }

        @JavascriptInterface
        public String getPetStorageInfo() {
            try {
                return petDatabase.storageInfo().put("success", true).toString();
            } catch (Exception error) {
                return bridgeError("读取存储状态失败", error).toString();
            }
        }

        @JavascriptInterface
        public void identify(String requestId, String imageDataUrl, String ignoredModel) {
            networkExecutor.execute(() -> {
                try {
                    JSONObject result = identifyCat(imageDataUrl);
                    dispatchResult(requestId, true, result.toString());
                } catch (OutOfMemoryError error) {
                    JSONObject payload = new JSONObject();
                    try {
                        payload.put("detail", "图片像素过大，无法处理；请缩小图片后重试");
                    } catch (JSONException ignored) {
                        // detail 是普通字符串。
                    }
                    dispatchResult(requestId, false, payload.toString());
                } catch (Exception error) {
                    JSONObject payload = new JSONObject();
                    try {
                        payload.put("detail", friendlyError(error));
                    } catch (JSONException ignored) {
                        // detail 是普通字符串。
                    }
                    dispatchResult(requestId, false, payload.toString());
                }
            });
        }

        @JavascriptInterface
        public void chat(String requestId, String question, String breedContext) {
            networkExecutor.execute(() -> {
                try {
                    JSONObject result = askKnowledge(question, breedContext);
                    dispatchChatResult(requestId, true, result.toString());
                } catch (OutOfMemoryError error) {
                    JSONObject payload = new JSONObject();
                    try {
                        payload.put("detail", "处理内容过多，请简化问题后重试");
                    } catch (JSONException ignored) {}
                    dispatchChatResult(requestId, false, payload.toString());
                } catch (Exception error) {
                    JSONObject payload = new JSONObject();
                    try {
                        payload.put("detail", friendlyError(error));
                    } catch (JSONException ignored) {}
                    dispatchChatResult(requestId, false, payload.toString());
                }
            });
        }

        @JavascriptInterface
        public String searchKnowledge(String query, int topK) {
            try {
                return searchKnowledgeLocal(query, topK).toString();
            } catch (Exception error) {
                JSONObject payload = new JSONObject();
                try {
                    payload.put("query", query == null ? "" : query);
                    payload.put("results", new JSONArray());
                    payload.put("count", 0);
                    payload.put("detail", "本地知识库搜索失败");
                } catch (JSONException ignored) {}
                return payload.toString();
            }
        }

        private JSONObject bridgeError(String message, Exception error) {
            JSONObject payload = new JSONObject();
            try {
                payload.put("success", false);
                payload.put("detail", message + "：" + limit(error.getMessage(), 240));
            } catch (JSONException ignored) {}
            return payload;
        }
    }

    private JSONObject identifyCat(String imageDataUrl) throws Exception {
        if (!BuildConfig.CAT_AI_BASE_URL.startsWith("https://")) {
            throw new IOException("为保护内置密钥，仅允许使用 HTTPS API 地址");
        }

        String jpegBase64 = compressImage(imageDataUrl);
        String systemPrompt = buildSystemPrompt();

        JSONObject payload = new JSONObject();
        payload.put("model", BuildConfig.CAT_AI_MODEL);
        payload.put("max_tokens", 8192);
        payload.put("temperature", 1.0);

        JSONArray messages = new JSONArray();
        messages.put(new JSONObject()
                .put("role", "system")
                .put("content", systemPrompt));

        JSONArray userContent = new JSONArray();
        userContent.put(new JSONObject()
                .put("type", "image_url")
                .put("image_url", new JSONObject()
                        .put("url", "data:image/jpeg;base64," + jpegBase64)));
        userContent.put(new JSONObject()
                .put("type", "text")
                .put("text", "请对照知识库鉴定这只猫的品种并提供详细分析。"));
        messages.put(new JSONObject()
                .put("role", "user")
                .put("content", userContent));
        payload.put("messages", messages);

        String modelContent = "";
        JSONObject parsed = null;
        Exception lastParseError = null;
        for (int attempt = 0; attempt < 2 && parsed == null; attempt++) {
            JSONObject apiResponse = postChatCompletion(payload);
            JSONArray choices = apiResponse.optJSONArray("choices");
            if (choices != null && choices.length() > 0) {
                JSONObject choice = choices.optJSONObject(0);
                JSONObject message = choice == null ? null : choice.optJSONObject("message");
                if (message != null) {
                    modelContent = message.optString("content", "");
                }
            }
            if (!modelContent.trim().isEmpty()) {
                try {
                    parsed = parseModelJson(modelContent);
                } catch (JSONException | IOException error) {
                    lastParseError = error;
                }
            }
        }
        if (parsed == null && modelContent.trim().isEmpty()) {
            throw new IOException("模型返回了空内容，请重试");
        }
        if (parsed == null) {
            throw new IOException("模型返回格式无法解析，请重试", lastParseError);
        }
        String breed = parsed.optString("breed", "未知品种");
        JSONObject appearance = parsed.optJSONObject("appearance");
        if (appearance == null) {
            appearance = new JSONObject();
        }

        JSONObject identification = new JSONObject();
        identification.put("breed", breed);
        identification.put("confidence", parsed.optString("confidence", "未知"));
        identification.put("description", parsed.optString("description", ""));
        identification.put("appearance", appearance);
        identification.put("health_observation", parsed.optString("health_observation", ""));
        identification.put("estimated_age", parsed.optString("estimated_age", ""));
        identification.put("notes", parsed.optString("notes", ""));

        JSONObject result = new JSONObject();
        result.put("success", true);
        result.put("model_used", BuildConfig.CAT_AI_PROVIDER + "/" + BuildConfig.CAT_AI_MODEL);
        result.put("identification", identification);
        result.put("knowledge", buildKnowledge(breed));
        return result;
    }

    private JSONObject askKnowledge(String question, String breedContext) throws Exception {
        if (!BuildConfig.CAT_AI_BASE_URL.startsWith("https://")) {
            throw new IOException("为保护内置密钥，仅允许使用 HTTPS API 地址");
        }

        StringBuilder knowledge = new StringBuilder();
        JSONArray citations = new JSONArray();
        Set<String> citationIds = new LinkedHashSet<>();

        // The user's question must dominate retrieval. Prefixing the breed used to
        // flood generic questions with breed-profile chunks and produced unrelated citations.
        appendKnowledgeReferences(
                searchKnowledgeLocal(question, 4), knowledge, citations, citationIds, 4);
        if (breedContext != null && !breedContext.trim().isEmpty()) {
            // Add at most one breed-specific supplement without displacing question matches.
            appendKnowledgeReferences(
                    searchKnowledgeLocal(breedContext.trim(), 2),
                    knowledge, citations, citationIds, 1);
        }
        if (knowledge.length() == 0) {
            knowledge.append("（本地知识库没有检索到直接相关内容）");
        }

        StringBuilder prompt = new StringBuilder();
        prompt.append("你是一位专业的猫咪知识顾问。请基于以下知识库内容，回答用户的问题。\n\n");
        if (breedContext != null && !breedContext.isEmpty()) {
            prompt.append("【当前关注的猫咪品种】").append(breedContext).append("\n\n");
        }
        prompt.append("【知识库】\n").append(knowledge).append("\n\n");
        prompt.append("【用户问题】").append(question).append("\n\n");
        prompt.append("请用中文回答，尽量简洁但专业。如果知识库中没有相关信息，请诚实告知。");

        JSONObject payload = new JSONObject();
        payload.put("model", BuildConfig.CAT_AI_MODEL);
        if ("minimax".equalsIgnoreCase(BuildConfig.CAT_AI_PROVIDER)) {
            payload.put("max_completion_tokens", 2048);
            payload.put("temperature", 0.2);
            payload.put("thinking", new JSONObject().put("type", "disabled"));
            payload.put("reasoning_split", true);
        } else {
            payload.put("max_tokens", 4096);
            payload.put("temperature", 1.0);
        }

        JSONArray messages = new JSONArray();
        messages.put(new JSONObject()
                .put("role", "system")
                .put("content", "你是一位专业的猫咪知识顾问，基于内置知识库为用户提供准确、实用的养猫建议。回答要简洁专业，避免冗长。"));
        messages.put(new JSONObject()
                .put("role", "user")
                .put("content", prompt.toString()));
        payload.put("messages", messages);

        String answer = "";
        for (int attempt = 0; attempt < 2 && answer.trim().isEmpty(); attempt++) {
            JSONObject apiResponse = postChatCompletion(payload);
            JSONArray choices = apiResponse.optJSONArray("choices");
            if (choices != null && choices.length() > 0) {
                JSONObject choice = choices.optJSONObject(0);
                JSONObject message = choice == null ? null : choice.optJSONObject("message");
                if (message != null) {
                    answer = message.optString("content", "");
                }
            }
        }
        if (answer.trim().isEmpty()) {
            throw new IOException("模型返回了空内容，请重试");
        }

        JSONObject result = new JSONObject();
        result.put("success", true);
        result.put("answer", answer);
        result.put("model_used", BuildConfig.CAT_AI_PROVIDER + "/" + BuildConfig.CAT_AI_MODEL);
        result.put("citations", citations);
        return result;
    }

    private void appendKnowledgeReferences(
            JSONObject searchData,
            StringBuilder knowledge,
            JSONArray citations,
            Set<String> citationIds,
            int maxItems
    ) throws JSONException {
        JSONArray references = searchData.optJSONArray("results");
        if (references == null || maxItems <= 0) return;
        JSONObject firstReference = references.optJSONObject(0);
        double topScore = firstReference == null ? 0 : firstReference.optDouble("score", 0);
        int added = 0;
        for (int index = 0; index < references.length() && added < maxItems; index++) {
            JSONObject item = references.optJSONObject(index);
            if (item == null) continue;
            double itemScore = item.optDouble("score", 0);
            if (index > 0 && topScore > 0 && itemScore < topScore * 0.35) continue;
            String id = item.optString("id", "");
            if (!id.isEmpty() && !citationIds.add(id)) continue;
            knowledge.append("【来源：").append(item.optString("title", "知识库"))
                    .append("】\n").append(item.optString("content", "")).append("\n\n");
            citations.put(new JSONObject()
                    .put("id", id)
                    .put("title", item.optString("title", ""))
                    .put("source", item.optString("source", "")));
            added++;
        }
    }

    private JSONObject postChatCompletion(JSONObject payload) throws IOException, JSONException {
        URL url = new URL(BuildConfig.CAT_AI_BASE_URL + "/chat/completions");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(180_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + decodeApiKey());
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Accept", "application/json");

        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }

        int status = connection.getResponseCode();
        InputStream responseStream = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
        String responseBody = responseStream == null ? "" : readStream(responseStream);
        connection.disconnect();

        if (status < 200 || status >= 300) {
            String detail = extractApiError(responseBody);
            throw new IOException("API 请求失败（" + status + "）" + (detail.isEmpty() ? "" : "：" + detail));
        }
        return new JSONObject(responseBody);
    }

    private String decodeApiKey() {
        byte[] encoded = Base64.decode(BuildConfig.CAT_AI_KEY_BLOB, Base64.DEFAULT);
        byte[] mask = BuildConfig.CAT_AI_KEY_MASK.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < encoded.length; i++) {
            encoded[i] = (byte) (encoded[i] ^ mask[i % mask.length]);
        }
        return new String(encoded, StandardCharsets.UTF_8);
    }

    private String compressImage(String dataUrl) throws IOException {
        if (dataUrl == null || dataUrl.isEmpty()) {
            throw new IOException("没有收到图片数据");
        }
        int comma = dataUrl.indexOf(',');
        String encoded = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
        if (encoded.length() > 40_000_000) {
            throw new IOException("图片过大，请选择 20MB 以内的照片");
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            throw new IOException("图片格式无效", error);
        }

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("无法读取这张图片，请换一张重试");
        }

        BitmapFactory.Options decodeOptions = new BitmapFactory.Options();
        decodeOptions.inSampleSize = 1;
        while (bounds.outWidth / decodeOptions.inSampleSize > 2048
                || bounds.outHeight / decodeOptions.inSampleSize > 2048) {
            decodeOptions.inSampleSize *= 2;
        }
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decodeOptions);
        if (bitmap == null) {
            throw new IOException("无法读取这张图片，请换一张重试");
        }

        final int maxSide = 1024;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        float scale = Math.min(1f, maxSide / (float) Math.max(width, height));
        Bitmap outputBitmap = bitmap;
        if (scale < 1f) {
            outputBitmap = Bitmap.createScaledBitmap(
                    bitmap,
                    Math.max(1, Math.round(width * scale)),
                    Math.max(1, Math.round(height * scale)),
                    true
            );
        }

        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!outputBitmap.compress(Bitmap.CompressFormat.JPEG, 85, output)) {
            throw new IOException("图片压缩失败");
        }
        if (outputBitmap != bitmap) {
            outputBitmap.recycle();
        }
        bitmap.recycle();
        return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
    }

    private String buildSystemPrompt() {
        String reference = readAssetTruncated("02_品种猫速查表.md", 6000)
                + "\n\n" + readAssetTruncated("03_中华田园猫细分.md", 4000)
                + "\n\n" + readAssetTruncated("01_选猫多维分类.md", 2500)
                + "\n\n" + readAssetTruncated("04_品相知识体系.md", 2500);

        return "你是一位专业的猫咪品种鉴定师。请仔细观察图片中的猫，从以下维度分析：\n"
                + "1. 品种鉴定：对照下方品种知识库逐项比对；若为本土猫，请细分到狸花猫、橘猫、奶牛猫、三花猫等类型。\n"
                + "2. 品相评估：毛色、花纹、体型、面部特征。\n"
                + "3. 健康观察：只描述图片中可见的状态，不能替代兽医诊断。\n"
                + "4. 年龄估算：根据体型和面部特征估算大致年龄段。\n\n"
                + "【品种知识库】\n" + reference + "\n\n"
                + "请用中文回答，严格返回单个 JSON 对象，不要使用 Markdown 代码块：\n"
                + "{\"breed\":\"品种名\",\"confidence\":\"高/中/低\",\"description\":\"详细描述\","
                + "\"appearance\":{\"color\":\"毛色\",\"pattern\":\"花纹\",\"body_type\":\"体型\","
                + "\"face_features\":\"面部特征\"},\"health_observation\":\"健康观察\","
                + "\"estimated_age\":\"幼猫/青年/成年/老年\",\"notes\":\"补充说明\"}";
    }

    private JSONObject parseModelJson(String content) throws JSONException, IOException {
        String cleaned = content.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replaceFirst("^```(?:json)?\\s*", "")
                    .replaceFirst("\\s*```$", "");
        }

        JSONException lastJsonError = null;
        int searchFrom = 0;
        while (searchFrom < cleaned.length()) {
            int firstBrace = cleaned.indexOf('{', searchFrom);
            if (firstBrace < 0) break;
            int lastBrace = findJsonObjectEnd(cleaned, firstBrace);
            if (lastBrace < 0) break;
            try {
                JSONObject candidate = new JSONObject(cleaned.substring(firstBrace, lastBrace + 1));
                if (candidate.has("breed")) {
                    return candidate;
                }
            } catch (JSONException error) {
                lastJsonError = error;
            }
            searchFrom = firstBrace + 1;
        }
        if (lastJsonError != null) throw lastJsonError;
        throw new IOException("响应中没有完整的品种识别 JSON");
    }

    private int findJsonObjectEnd(String text, int start) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < text.length(); i++) {
            char value = text.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (value == '\\') {
                    escaped = true;
                } else if (value == '"') {
                    inString = false;
                }
                continue;
            }
            if (value == '"') {
                inString = true;
            } else if (value == '{') {
                depth++;
            } else if (value == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    private JSONObject searchKnowledgeLocal(String query, int topK) throws JSONException {
        String safeQuery = query == null ? "" : query.trim();
        JSONObject response = new JSONObject();
        response.put("query", safeQuery);
        JSONArray results = new JSONArray();
        response.put("results", results);
        if (safeQuery.isEmpty()) {
            response.put("count", 0);
            return response;
        }

        String[] files = {
                "01_选猫多维分类.md", "02_品种猫速查表.md", "03_中华田园猫细分.md",
                "04_品相知识体系.md", "05_市场价格体系.md", "06_健康知识库.md",
                "07_生命周期与疫苗.md", "08_饮食与禁忌.md", "09_品种猫详录.md",
                "10_来源附录.md"
        };
        Set<String> terms = expandKnowledgeQuery(safeQuery);
        String compactQuery = compactText(safeQuery);
        List<KnowledgeHit> hits = new ArrayList<>();

        for (String file : files) {
            String document = readAsset(file);
            if (document.isEmpty()) continue;
            String[] sections = document.split("(?m)(?=^#{1,4}\\s+)");
            for (int sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
                String section = sections[sectionIndex].trim();
                if (section.isEmpty()) continue;
                String firstLine = section.split("\\R", 2)[0].replaceFirst("^#{1,4}\\s*", "").trim();
                if (firstLine.isEmpty()) firstLine = file.replace(".md", "");

                int start = 0;
                int part = 1;
                while (start < section.length()) {
                    int end = Math.min(section.length(), start + 1400);
                    String content = section.substring(start, end).trim();
                    if (!content.isEmpty()) {
                        String title = file.replace(".md", "") + " · " + firstLine
                                + (section.length() > 1400 ? "（" + part + "）" : "");
                        double score = scoreKnowledgeChunk(compactQuery, terms, title, content)
                                + sourceIntentBoost(safeQuery, file);
                        if (score > 0) {
                            hits.add(new KnowledgeHit(
                                    file + "#" + sectionIndex + "-" + part,
                                    file,
                                    title,
                                    content,
                                    score
                            ));
                        }
                    }
                    if (end >= section.length()) break;
                    start += 1200;
                    part++;
                }
            }
        }

        Collections.sort(hits, (left, right) -> Double.compare(right.score, left.score));
        int requested = Math.max(1, Math.min(topK, 10));
        int limit = Math.min(requested, hits.size());
        for (int i = 0; i < limit; i++) {
            KnowledgeHit hit = hits.get(i);
            results.put(new JSONObject()
                    .put("id", hit.id)
                    .put("source", hit.source)
                    .put("title", hit.title)
                    .put("content", hit.content)
                    .put("type", "markdown")
                    .put("score", Math.round(hit.score * 100.0) / 100.0));
        }
        response.put("count", results.length());
        return response;
    }

    private Set<String> expandKnowledgeQuery(String query) {
        String normalized = query.toLowerCase(Locale.ROOT);
        Set<String> terms = new LinkedHashSet<>();
        for (String token : normalized.split("[^a-z0-9_\\-\\u4e00-\\u9fff]+")) {
            if (token.length() > 1) terms.add(token);
            for (int width : new int[]{2, 3}) {
                for (int index = 0; index + width <= token.length(); index++) {
                    terms.add(token.substring(index, index + width));
                }
            }
        }
        addIntentTerms(normalized, terms, new String[]{"不能吃", "吃什么", "禁食", "有毒"},
                new String[]{"饮食", "禁忌", "有毒", "中毒", "食物"});
        addIntentTerms(normalized, terms, new String[]{"什么病", "容易得", "生病", "疾病"},
                new String[]{"健康", "疾病", "遗传病", "常见病", "症状"});
        addIntentTerms(normalized, terms, new String[]{"性格", "特征", "特点"},
                new String[]{"性格", "特征", "外观", "体型", "被毛"});
        addIntentTerms(normalized, terms, new String[]{"疫苗", "驱虫"},
                new String[]{"疫苗", "驱虫", "免疫", "接种"});
        addIntentTerms(normalized, terms, new String[]{"价格", "多少钱", "贵不贵"},
                new String[]{"价格", "市场价", "宠物级", "赛级"});
        addIntentTerms(normalized, terms, new String[]{"喂养", "饲养", "护理"},
                new String[]{"饲养", "护理", "喂食", "饮食"});

        String[][] aliases = {
                {"英短", "英国短毛猫"}, {"美短", "美国短毛猫"}, {"布偶", "布偶猫"},
                {"狸花", "狸花猫"}, {"暹罗", "暹罗猫"}, {"缅因", "缅因猫"},
                {"加菲", "异国短毛猫"}, {"无毛猫", "斯芬克斯猫"}
        };
        for (String[] alias : aliases) {
            if (normalized.contains(alias[0]) || normalized.contains(alias[1])) {
                terms.add(alias[0]);
                terms.add(alias[1]);
            }
        }
        return terms;
    }

    private void addIntentTerms(
            String query,
            Set<String> terms,
            String[] triggers,
            String[] additions
    ) {
        for (String trigger : triggers) {
            if (!query.contains(trigger)) continue;
            Collections.addAll(terms, additions);
            return;
        }
    }

    private double scoreKnowledgeChunk(
            String compactQuery,
            Set<String> terms,
            String title,
            String content
    ) {
        String compactTitle = compactText(title);
        String compactContent = compactText(content);
        String haystack = compactTitle + compactContent;
        double score = !compactQuery.isEmpty() && haystack.contains(compactQuery) ? 30.0 : 0.0;
        for (String term : terms) {
            String compactTerm = compactText(term);
            if (compactTerm.length() < 2) continue;
            int count = Math.min(countOccurrences(haystack, compactTerm), 6);
            if (count == 0) continue;
            int weight = Math.min(compactTerm.length(), 5);
            score += count * weight;
            if (compactTitle.contains(compactTerm)) score += weight * 3.0;
        }
        return score;
    }

    private double sourceIntentBoost(String query, String source) {
        String normalized = query.toLowerCase(Locale.ROOT);
        if (containsAny(normalized, new String[]{"什么病", "容易得", "生病", "疾病", "健康"})
                && (source.startsWith("06_") || source.startsWith("09_"))) return 24.0;
        if (containsAny(normalized, new String[]{"巧克力", "可可碱", "洋葱", "大蒜", "葡萄干",
                "百合", "木糖醇", "咖啡因", "酒精", "能吃", "不能吃", "吃什么", "饮食", "禁忌", "有毒"})
                && source.startsWith("08_")) return 60.0;
        if (containsAny(normalized, new String[]{"疫苗", "驱虫", "绝育"})
                && source.startsWith("07_")) return 24.0;
        if (containsAny(normalized, new String[]{"价格", "多少钱", "贵不贵", "市场价"})
                && source.startsWith("05_")) return 24.0;
        if (containsAny(normalized, new String[]{"品相", "外观", "毛色", "花纹"})
                && (source.startsWith("04_") || source.startsWith("09_"))) return 24.0;
        return 0.0;
    }

    private boolean containsAny(String text, String[] values) {
        for (String value : values) {
            if (text.contains(value)) return true;
        }
        return false;
    }

    private String compactText(String value) {
        return value.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
    }

    private int countOccurrences(String text, String term) {
        int count = 0;
        int offset = 0;
        while ((offset = text.indexOf(term, offset)) >= 0) {
            count++;
            offset += term.length();
        }
        return count;
    }

    private JSONObject buildKnowledge(String breed) throws JSONException {
        JSONObject knowledge = new JSONObject();
        knowledge.put("breed", breed);
        knowledge.put("basic", categoryKnowledge(breed,
                new String[]{"02_品种猫速查表.md", "03_中华田园猫细分.md", "09_品种猫详录.md"},
                "02_品种猫速查表.md"));
        knowledge.put("health", categoryKnowledge(breed,
                new String[]{"06_健康知识库.md", "07_生命周期与疫苗.md", "09_品种猫详录.md"},
                "06_健康知识库.md"));
        knowledge.put("care", categoryKnowledge(breed,
                new String[]{"08_饮食与禁忌.md", "07_生命周期与疫苗.md", "09_品种猫详录.md"},
                "08_饮食与禁忌.md"));
        knowledge.put("price", categoryKnowledge(breed,
                new String[]{"05_市场价格体系.md", "04_品相知识体系.md", "09_品种猫详录.md"},
                "05_市场价格体系.md"));
        return knowledge;
    }

    private String categoryKnowledge(String breed, String[] files, String fallbackFile) {
        StringBuilder result = new StringBuilder();
        for (String file : files) {
            String content = readAsset(file);
            String excerpt = findBreedExcerpt(content, breed);
            if (!excerpt.isEmpty()) {
                if (result.length() > 0) {
                    result.append("\n\n");
                }
                result.append('【').append(file.replace(".md", "")).append("】\n").append(excerpt);
                if (result.length() >= 2600) {
                    break;
                }
            }
        }
        if (result.length() == 0) {
            String fallback = readAssetTruncated(fallbackFile, 1800);
            return fallback.isEmpty() ? "暂无相关知识。" : fallback;
        }
        return result.substring(0, Math.min(result.length(), 3000));
    }

    private String findBreedExcerpt(String content, String breed) {
        if (content.isEmpty() || breed == null || breed.trim().isEmpty()) {
            return "";
        }

        List<String> candidates = new ArrayList<>();
        candidates.add(breed.trim());
        String compact = breed.replaceAll("[\\s（）()·/\\-]", "");
        if (compact.endsWith("猫") && compact.length() > 2) {
            candidates.add(compact.substring(0, compact.length() - 1));
        }
        String[] known = {"英国短毛", "英短", "美国短毛", "美短", "布偶", "暹罗", "缅因", "波斯",
                "异国短毛", "加菲", "德文", "斯芬克斯", "孟加拉", "狸花", "橘猫", "奶牛猫", "三花"};
        for (String name : known) {
            if (breed.contains(name)) {
                candidates.add(name);
            }
        }

        int index = -1;
        for (String candidate : candidates) {
            if (candidate.length() < 2) {
                continue;
            }
            index = content.indexOf(candidate);
            if (index >= 0) {
                break;
            }
        }
        if (index < 0) {
            return "";
        }

        int heading2 = content.lastIndexOf("\n## ", index);
        int heading3 = content.lastIndexOf("\n### ", index);
        int start = Math.max(heading2, heading3);
        if (start < 0 || index - start > 700) {
            start = Math.max(0, index - 350);
        } else {
            start += 1;
        }

        int next2 = content.indexOf("\n## ", index + 1);
        int next3 = content.indexOf("\n### ", index + 1);
        int end = minPositive(next2, next3);
        if (end < 0 || end - start > 1800) {
            end = Math.min(content.length(), start + 1800);
        }
        return content.substring(start, end).trim();
    }

    private int minPositive(int first, int second) {
        if (first < 0) return second;
        if (second < 0) return first;
        return Math.min(first, second);
    }

    private String readAssetTruncated(String name, int maxChars) {
        String content = readAsset(name);
        if (content.length() <= maxChars) {
            return content;
        }
        return content.substring(0, maxChars) + "\n……（节选）";
    }

    private String readAsset(String name) {
        try (InputStream input = getAssets().open(name)) {
            return readStream(input);
        } catch (IOException ignored) {
            return "";
        }
    }

    private String readStream(InputStream input) throws IOException {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) >= 0) {
                result.append(buffer, 0, count);
            }
        }
        return result.toString();
    }

    private String extractApiError(String responseBody) {
        try {
            JSONObject response = new JSONObject(responseBody);
            Object error = response.opt("error");
            if (error instanceof JSONObject) {
                return limit(((JSONObject) error).optString("message", ""), 300);
            }
            if (error != null) {
                return limit(error.toString(), 300);
            }
            return limit(response.optString("message", ""), 300);
        } catch (JSONException ignored) {
            return "";
        }
    }

    private String friendlyError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return "识别失败，请检查网络后重试";
        }
        String lower = message.toLowerCase(Locale.ROOT);
        if (lower.contains("unable to resolve host") || lower.contains("failed to connect")) {
            return "无法连接模型服务，请检查网络后重试";
        }
        if (lower.contains("timeout") || lower.contains("timed out")) {
            return "模型响应超时，请稍后重试";
        }
        return limit(message, 400);
    }

    private String limit(String value, int length) {
        if (value == null) return "";
        return value.length() <= length ? value : value.substring(0, length) + "…";
    }

    private void dispatchResult(String requestId, boolean success, String payload) {
        runOnUiThread(() -> {
            if (webView == null) return;
            String script = "window.CatAiAndroid && window.CatAiAndroid.onIdentifyResult("
                    + JSONObject.quote(requestId) + ","
                    + success + ","
                    + JSONObject.quote(payload) + ");";
            webView.evaluateJavascript(script, null);
        });
    }

    private void dispatchChatResult(String requestId, boolean success, String payload) {
        runOnUiThread(() -> {
            if (webView == null) return;
            String script = "window.CatAiAndroid && window.CatAiAndroid.onChatResult("
                    + JSONObject.quote(requestId) + ","
                    + success + ","
                    + JSONObject.quote(payload) + ");";
            webView.evaluateJavascript(script, null);
        });
    }
}
