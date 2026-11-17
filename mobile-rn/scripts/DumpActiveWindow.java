import android.app.UiAutomation;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.lang.reflect.Method;

public final class DumpActiveWindow {
    public static void main(String[] args) throws Exception {
        // Use the emulator's UI Automator dumper without requiring 1 second of idle UI.
        Class<?> wrapperType = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
        Object wrapper = wrapperType.getConstructor().newInstance();
        wrapperType.getMethod("connect").invoke(wrapper);
        File output = new File(args.length > 2 ? args[2] : "/data/local/tmp/opengym-window.xml");
        try {
            UiAutomation automation = (UiAutomation) wrapperType.getMethod("getUiAutomation").invoke(wrapper);
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            for (int attempt = 0; root == null && attempt < 15; attempt++) {
                Thread.sleep(100);
                root = automation.getRootInActiveWindow();
            }
            if (root != null) {
                Class<?> dumperType = Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper");
                Method dump = dumperType.getMethod("dumpWindowToFile", AccessibilityNodeInfo.class,
                        File.class, int.class, int.class, int.class);
                dump.invoke(null, root, output, 0, Integer.parseInt(args[0]), Integer.parseInt(args[1]));
            }
        } finally {
            wrapperType.getMethod("disconnect").invoke(wrapper);
        }
        System.exit(0);
    }
}
