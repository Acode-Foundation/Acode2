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
        weakContext = new WeakReference<>(this);

        loadUrl(launchUrl);
        
        // Attach EditorContextMenu to the WebView
        EditorContextMenu.get().attach(this, ((SystemWebViewEngine)appView.getEngine()).getView());
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        if (mActionMode == null) {
            mActionMode = mode;
            
            // Notify the EditorContextMenu manager
            EditorContextMenu.get().onActionModeStarted(mode);
            
            // Add custom menu items
            Menu menu = mode.getMenu();
            EditorContextMenu.get().onPrepareActionMode(menu);
        }
        super.onActionModeStarted(mode);
    }

    @Override
    public void onActionModeFinished(ActionMode mode) {
        // Notify the EditorContextMenu manager
        EditorContextMenu.get().onActionModeFinished(mode);
        
        mActionMode = null;
        super.onActionModeFinished(mode);
    }
} 