package com.foxdebug.system;

import android.app.Activity;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.PluginResult;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Singleton manager for WebView / Editor selection menu (ActionMode)
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
    private ActionMode currentActionMode = null;
    private boolean keepDefaultItems = true;

    /* ---------------- public API ---------------- */

    public void attach(Activity activity, View webView) {
        // ActionMode is automatically handled by MainActivity.onActionModeStarted
        // This method is kept for API compatibility
    }

    public void detach(Activity activity, View webView) {
        if (currentActionMode != null) {
            currentActionMode.finish();
            currentActionMode = null;
        }
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
        
        // Refresh the menu if currently showing
        if (currentActionMode != null) {
            currentActionMode.invalidate();
        }
    }

    public void setItemEnabled(int id, boolean enabled) {
        Item item = items.get(id);
        if (item != null) {
            item.enabled = enabled;
            
            // Refresh the menu if currently showing
            if (currentActionMode != null) {
                currentActionMode.invalidate();
            }
        }
    }

    public void setAllEnabled(boolean enabled) {
        globallyEnabled = enabled;
        
        // Refresh the menu if currently showing
        if (currentActionMode != null) {
            currentActionMode.invalidate();
        }
    }

    public void setKeepDefaultItems(boolean keep) {
        keepDefaultItems = keep;
    }

    public void clear() {
        items.clear();
        
        // Refresh the menu if currently showing
        if (currentActionMode != null) {
            currentActionMode.invalidate();
        }
    }

    /* ---------------- Activity hooks (called from MainActivity) ---------------- */

    public void onActionModeStarted(ActionMode mode) {
        currentActionMode = mode;
    }

    public void onActionModeFinished(ActionMode mode) {
        if (currentActionMode == mode) {
            currentActionMode = null;
        }
    }

    public void onPrepareActionMode(Menu menu) {
        if (!globallyEnabled) return;

        // Remove default items if requested
        if (!keepDefaultItems) {
            menu.clear();
        }

        // Add custom items
        for (Item item : items.values()) {
            if (item.enabled) {
                MenuItem menuItem = menu.add(Menu.NONE, item.id, Menu.NONE, item.title);
                menuItem.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
                
                // Set click listener
                menuItem.setOnMenuItemClickListener(new MenuItem.OnMenuItemClickListener() {
                    @Override
                    public boolean onMenuItemClick(MenuItem clickedItem) {
                        return onActionItemClicked(clickedItem);
                    }
                });
            }
        }
    }

    private boolean onActionItemClicked(MenuItem menuItem) {
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
            
            // Finish the action mode
            if (currentActionMode != null) {
                currentActionMode.finish();
            }
        } catch (Exception e) {
            item.callback.error(e.getMessage());
        }

        return true;
    }
}