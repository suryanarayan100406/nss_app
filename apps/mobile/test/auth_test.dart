import 'package:flutter_test/flutter_test.dart';

import 'package:nss_mobile/models.dart';

void main() {
  test('role parsing preserves server authorization vocabulary', () {
    expect(roleFromJson('ADMIN'), UserRole.admin);
    expect(roleFromJson('APPROVER'), UserRole.approver);
    expect(roleFromJson('USER'), UserRole.user);
  });

  test('event DTO parses timezone and upload window', () {
    final event = EventRecord.fromJson({
      'id': 'evt',
      'slug': 'walkathon',
      'title': 'Walkathon',
      'summary': 'Walk together',
      'description': 'A community walk',
      'category': 'Outreach',
      'startAt': '2026-09-27T04:00:00.000Z',
      'endAt': null,
      'timezone': 'Asia/Kolkata',
      'venue': 'Campus',
      'status': 'PUBLISHED',
      'uploadOpensAt': '2026-09-27T00:00:00.000Z',
      'uploadClosesAt': '2026-10-10T00:00:00.000Z',
      'cover': null,
      'gallery': <dynamic>[],
    });
    expect(event.timezone, 'Asia/Kolkata');
    expect(event.uploadClosesAt, isNotNull);
    expect(
      uploadWindowIsOpen(event, DateTime.parse('2026-10-01T00:00:00.000Z')),
      isTrue,
    );
    expect(
      uploadWindowIsOpen(event, DateTime.parse('2026-10-11T00:00:00.000Z')),
      isFalse,
    );
  });

  test('review DTO keeps moderation context for approvers', () {
    final item = ReviewItem.fromJson({
      'id': 'photo',
      'fileName': 'drive.jpg',
      'event': {'title': 'Cleanliness drive'},
      'contributor': {'displayName': 'Student'},
      'previewUrl': '/api/v1/moderation/photos/photo/preview',
      'status': 'PENDING_REVIEW',
      'width': 1600,
      'height': 1200,
      'submittedAt': '2026-10-01T00:00:00.000Z',
      'duplicateWarning': 'Near duplicate',
      'warnings': ['soft image'],
    });
    expect(item.width, 1600);
    expect(item.duplicateWarning, 'Near duplicate');
    expect(item.warnings, ['soft image']);
  });
}
