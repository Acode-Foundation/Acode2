/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
 */

package com.foxdebug.acode;

import android.os.Bundle;

import org.apache.cordova.*;
import android.content.Context;
import java.lang.ref.WeakReference;
import com.foxdebug.system.*;

import android.view.MenuItem;
import android.view.View;
import org.apache.cordova.engine.SystemWebViewEngine;

import android.view.ActionMode;
import android.view.Menu;
import android.webkit.WebView;


public class MainActivity extends CordovaActivity
{

    private static WeakReference<Context> weakContext;
    private ActionMode mActionMode = null;

    public static Context getContext() {
        return weakContext != null ? weakContext.get() : null;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        loadUrl(launchUrl);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        if (mActionMode == null) {
            mActionMode = mode;
            Menu menu = mode.getMenu();
            
            // Add custom menu item
            menu.add(Menu.NONE, 1001, 0, "Format Code").setOnMenuItemClickListener(new MenuItem.OnMenuItemClickListener() {
                @Override
                public boolean onMenuItemClick(MenuItem item) {
                    // TODO: Add your format code logic here
                    // You can send this event to JavaScript via Cordova plugin
                    if (mActionMode != null) {
                        mActionMode.finish();
                    }
                    return true;
                }
            });
            
            // If you want to remove default items, uncomment:
            // menu.removeItem(android.R.id.copy);
            // menu.removeItem(android.R.id.selectAll);
            // menu.removeItem(android.R.id.cut);
            // menu.removeItem(android.R.id.paste);
        }
        super.onActionModeStarted(mode);
    }

    @Override
    public void onActionModeFinished(ActionMode mode) {
        mActionMode = null;
        super.onActionModeFinished(mode);
    }
}