package com.foxdebug.system;

import android.app.Activity;
import android.view.ContextMenu;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.PluginResult;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Singleton manager for WebView / Editor context menu
 * Designed for Cordova (SystemWebView)
 */
public final class EditorContextMenu {

    /* ---------------- singleton ---------------- */

    private static EditorContextMenu INSTANCE;

    public static synchronized EditorContextMenu get() {
        if (INSTANCE == null) {
            INSTANCE = new EditorContextMenu();
        }
        return INSTANCE;
    }

    private EditorContextMenu() {}

    /* ---------------- internal model ---------------- */

    private static class Item {
        final int id;
        final String title;
        final CallbackContext callback;
        boolean enabled = true;

        Item(int id, String title, CallbackContext callback) {
            this.id = id;
            this.title = title;
            this.callback = callback;
        }
    }

    /* ---------------- state ---------------- */

    private final Map<Integer, Item> items = new HashMap<>();
    private boolean globallyEnabled = true;

    /* ---------------- public API ---------------- */

    public void attach(Activity activity, View webView) {
        activity.registerForContextMenu(webView);
    }

    public void detach(Activity activity, View webView) {
        activity.unregisterForContextMenu(webView);
        clear();
    }

    public void addItem(int id, String title, CallbackContext callback) {
        items.put(id, new Item(id, title, callback));

        PluginResult pr = new PluginResult(PluginResult.Status.NO_RESULT);
        pr.setKeepCallback(true);
        callback.sendPluginResult(pr);
    }

    public void removeItem(int id) {
        items.remove(id);
    }

    public void setItemEnabled(int id, boolean enabled) {
        Item item = items.get(id);
        if (item != null) item.enabled = enabled;
    }

    public void setAllEnabled(boolean enabled) {
        globallyEnabled = enabled;
    }

    public void clear() {
        items.clear();
    }

    /* ---------------- Activity hooks ---------------- */

    public void onCreateContextMenu(ContextMenu menu) {
        if (!globallyEnabled) return;

        for (Item item : items.values()) {
            if (item.enabled) {
                menu.add(Menu.NONE, item.id, Menu.NONE, item.title);
            }
        }
    }

    public boolean onContextItemSelected(MenuItem menuItem) {
        Item item = items.get(menuItem.getItemId());
        if (item == null || !item.enabled || !globallyEnabled) {
            return false;
        }

        try {
            JSONObject result = new JSONObject();
            result.put("id", item.id);
            result.put("title", item.title);

            PluginResult pr = new PluginResult(
                PluginResult.Status.OK,
                result
            );
            pr.setKeepCallback(true);
            item.callback.sendPluginResult(pr);
        } catch (Exception e) {
            item.callback.error(e.getMessage());
        }

        return true;
    }
}
