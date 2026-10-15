import 'package:background_downloader/background_downloader.dart';
import 'package:flutter/widgets.dart';

import 'app.dart';
import 'screens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  configureUploadQueueCallbacks();
  await FileDownloader().start(autoCleanDatabase: true);
  final controller = AppController(createApi());
  await controller.bootstrap();
  runApp(NssApp(controller: controller));
}
