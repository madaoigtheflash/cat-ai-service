# JavaScript 通过固定方法名调用原生桥，R8 不可重命名或删除这些成员。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.closeai.catai.MainActivity$AndroidBridge { *; }

