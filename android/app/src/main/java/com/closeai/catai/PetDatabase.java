package com.closeai.catai;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

/** Local, device-private storage for pet profiles and future re-identification data. */
final class PetDatabase extends SQLiteOpenHelper {
    static final String DATABASE_NAME = "cat_ai.db";
    static final int DATABASE_VERSION = 1;
    private static final int MAX_PETS = 500;
    private static final int MAX_JSON_CHARS = 16 * 1024 * 1024;
    private static final String LEGACY_MIGRATION_KEY = "legacy_local_storage_v1_migrated";

    PetDatabase(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE pets ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "data_json TEXT NOT NULL,"
                + "created_at REAL NOT NULL DEFAULT 0,"
                + "updated_at REAL NOT NULL DEFAULT 0"
                + ")");
        db.execSQL("CREATE INDEX pets_created_at_idx ON pets(created_at DESC)");

        db.execSQL("CREATE TABLE pet_photos ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "pet_id TEXT NOT NULL,"
                + "local_uri TEXT NOT NULL,"
                + "purpose TEXT NOT NULL DEFAULT 'profile',"
                + "captured_at REAL NOT NULL DEFAULT 0,"
                + "quality_json TEXT NOT NULL DEFAULT '{}',"
                + "FOREIGN KEY(pet_id) REFERENCES pets(id) ON DELETE CASCADE"
                + ")");
        db.execSQL("CREATE INDEX pet_photos_pet_idx ON pet_photos(pet_id, captured_at DESC)");

        db.execSQL("CREATE TABLE identity_templates ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "pet_id TEXT NOT NULL,"
                + "source_photo_id TEXT,"
                + "model_version TEXT NOT NULL,"
                + "dimension INTEGER NOT NULL,"
                + "vector BLOB NOT NULL,"
                + "created_at REAL NOT NULL DEFAULT 0,"
                + "active INTEGER NOT NULL DEFAULT 1,"
                + "FOREIGN KEY(pet_id) REFERENCES pets(id) ON DELETE CASCADE,"
                + "FOREIGN KEY(source_photo_id) REFERENCES pet_photos(id) ON DELETE SET NULL"
                + ")");
        db.execSQL("CREATE INDEX identity_templates_pet_idx "
                + "ON identity_templates(pet_id, active, created_at DESC)");

        db.execSQL("CREATE TABLE identity_match_events ("
                + "id TEXT PRIMARY KEY NOT NULL,"
                + "query_photo_id TEXT,"
                + "predicted_pet_id TEXT,"
                + "confirmed_pet_id TEXT,"
                + "score REAL,"
                + "decision TEXT NOT NULL,"
                + "feedback TEXT NOT NULL DEFAULT '',"
                + "model_version TEXT NOT NULL,"
                + "created_at REAL NOT NULL DEFAULT 0,"
                + "FOREIGN KEY(query_photo_id) REFERENCES pet_photos(id) ON DELETE SET NULL,"
                + "FOREIGN KEY(predicted_pet_id) REFERENCES pets(id) ON DELETE SET NULL,"
                + "FOREIGN KEY(confirmed_pet_id) REFERENCES pets(id) ON DELETE SET NULL"
                + ")");
        db.execSQL("CREATE INDEX identity_events_created_idx "
                + "ON identity_match_events(created_at DESC)");

        db.execSQL("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Version 1 is the initial schema. Future versions must use additive migrations.
    }

    synchronized JSONArray listPets() throws JSONException {
        JSONArray pets = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query(
                "pets", new String[]{"data_json"}, null, null,
                null, null, "created_at DESC, id ASC")) {
            while (cursor.moveToNext()) {
                pets.put(new JSONObject(cursor.getString(0)));
            }
        }
        return pets;
    }

    synchronized JSONObject getPet(String petId) throws JSONException {
        if (petId == null || petId.trim().isEmpty()) return null;
        try (Cursor cursor = getReadableDatabase().query(
                "pets", new String[]{"data_json"}, "id = ?",
                new String[]{petId}, null, null, null, "1")) {
            return cursor.moveToFirst() ? new JSONObject(cursor.getString(0)) : null;
        }
    }

    synchronized int replacePets(JSONArray pets) throws JSONException {
        validatePets(pets);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            Set<String> staleIds = existingPetIds(db);
            for (int index = 0; index < pets.length(); index++) {
                JSONObject pet = pets.getJSONObject(index);
                String id = requirePetId(pet);
                staleIds.remove(id);
                upsertPet(db, pet);
            }
            for (String staleId : staleIds) {
                db.delete("pets", "id = ?", new String[]{staleId});
            }
            db.setTransactionSuccessful();
            return pets.length();
        } finally {
            db.endTransaction();
        }
    }

    synchronized JSONObject migrateLegacyPets(String legacyJson) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        boolean alreadyMigrated = hasSetting(db, LEGACY_MIGRATION_KEY);
        int imported = 0;
        if (!alreadyMigrated) {
            JSONArray legacyPets;
            try {
                legacyPets = legacyJson == null || legacyJson.trim().isEmpty()
                        ? new JSONArray() : new JSONArray(legacyJson);
            } catch (JSONException error) {
                legacyPets = new JSONArray();
            }
            validatePets(legacyPets);
            db.beginTransaction();
            try {
                for (int index = 0; index < legacyPets.length(); index++) {
                    JSONObject pet = legacyPets.getJSONObject(index);
                    upsertPet(db, pet);
                    imported++;
                }
                putSetting(db, LEGACY_MIGRATION_KEY, String.valueOf(System.currentTimeMillis()));
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        }
        return new JSONObject()
                .put("success", true)
                .put("already_migrated", alreadyMigrated)
                .put("imported", imported);
    }

    synchronized JSONObject storageInfo() throws JSONException {
        SQLiteDatabase db = getReadableDatabase();
        return new JSONObject()
                .put("database", DATABASE_NAME)
                .put("version", DATABASE_VERSION)
                .put("pet_count", countRows(db, "pets"))
                .put("photo_count", countRows(db, "pet_photos"))
                .put("template_count", countRows(db, "identity_templates"))
                .put("feedback_count", countRows(db, "identity_match_events"));
    }

    private void validatePets(JSONArray pets) throws JSONException {
        if (pets.length() > MAX_PETS) {
            throw new JSONException("宠物档案数量超过本地上限");
        }
        if (pets.toString().length() > MAX_JSON_CHARS) {
            throw new JSONException("宠物档案数据过大");
        }
        Set<String> ids = new LinkedHashSet<>();
        for (int index = 0; index < pets.length(); index++) {
            String id = requirePetId(pets.getJSONObject(index));
            if (!ids.add(id)) throw new JSONException("存在重复的宠物档案 ID");
        }
    }

    private String requirePetId(JSONObject pet) throws JSONException {
        String id = pet.optString("id", "").trim();
        if (id.isEmpty() || id.length() > 128) throw new JSONException("宠物档案 ID 无效");
        return id;
    }

    private void upsertPet(SQLiteDatabase db, JSONObject pet) throws JSONException {
        String id = requirePetId(pet);
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("data_json", pet.toString());
        values.put("created_at", finiteTimestamp(pet.optDouble("created_at", 0)));
        values.put("updated_at", finiteTimestamp(pet.optDouble("updated_at", 0)));
        // Do not use CONFLICT_REPLACE: SQLite implements it as delete + insert,
        // which would trigger ON DELETE CASCADE and erase photos/templates.
        int updated = db.update("pets", values, "id = ?", new String[]{id});
        if (updated == 0) db.insertOrThrow("pets", null, values);
    }

    private double finiteTimestamp(double value) {
        return Double.isNaN(value) || Double.isInfinite(value) ? 0 : value;
    }

    private Set<String> existingPetIds(SQLiteDatabase db) {
        Set<String> ids = new LinkedHashSet<>();
        try (Cursor cursor = db.query("pets", new String[]{"id"},
                null, null, null, null, null)) {
            while (cursor.moveToNext()) ids.add(cursor.getString(0));
        }
        return ids;
    }

    private boolean hasSetting(SQLiteDatabase db, String key) {
        try (Cursor cursor = db.query("settings", new String[]{"value"}, "key = ?",
                new String[]{key}, null, null, null, "1")) {
            return cursor.moveToFirst();
        }
    }

    private void putSetting(SQLiteDatabase db, String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        db.insertWithOnConflict("settings", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private long countRows(SQLiteDatabase db, String table) {
        try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            return cursor.moveToFirst() ? cursor.getLong(0) : 0;
        }
    }
}
